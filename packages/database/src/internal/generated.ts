import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, isAbsolute, join } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"
import { describeDatabaseContribution } from "../contributions.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { loadContributedDatabaseSchema, loadDatabaseSchema } from "./schema-tables.ts"

import type { ResolvedDatabaseContribution } from "../contributions.ts"
import type { DatabaseTableNameOptions, LoadedDatabaseSchema } from "./schema-tables.ts"
import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

const reservedSchemaExports = new Set(["default", "schema"])

function renderExportName(name: string) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

/** Imports a contribution from a generated file: absolute files relative to it, package specifiers as written. */
function contributionImportPath(file: string, contribution: ResolvedDatabaseContribution) {
  return isAbsolute(contribution.module) ? createImportPath(file, contribution.module) : contribution.module
}

/** Renders the import of contributed tables into a generated module. */
export function renderContributionImport(file: string, contribution: ResolvedDatabaseContribution, variable: string, typeOnly = false) {
  const keyword = typeOnly ? "import type" : "import"
  const from = JSON.stringify(contributionImportPath(file, contribution))
  return contribution.export
    ? `${keyword} { ${renderExportName(contribution.export)} as ${variable} } from ${from}`
    : `${keyword} ${variable} from ${from}`
}

interface SchemaPart {
  /** Expression that evaluates to the schema object. */
  expression: string
  owner: string
  schema: LoadedDatabaseSchema
}

/**
 * Fails with `DATABASE_B0010` when two schema parts use one key or one SQL table name. The generated schema spreads
 * every part into one object, and drizzle-kit needs one table per name.
 */
function assertDistinctTables(database: string, parts: SchemaPart[]) {
  const keys = new Map<string, string>()
  const sqlNames = new Map<string, string>()
  for (const part of parts) {
    for (const key of part.schema.keys) {
      const existing = keys.get(key)
      if (existing) {
        throw databaseErrorDiagnostics.DATABASE_B0010({ message: `[vitehub] Database "${database}" has two schema entries with the key ${JSON.stringify(key)}:\n  - ${existing}\n  - ${part.owner}\nRename one key, or remove the contribution. If the Definition already lists the contributed tables, remove them from its schema.` })
      }
      keys.set(key, part.owner)
    }
    // One part may list a table under two keys; only another part's table with the same name collides.
    for (const sqlName of new Set(part.schema.sqlNames.values())) {
      const existing = sqlNames.get(sqlName)
      if (existing) {
        throw databaseErrorDiagnostics.DATABASE_B0010({ message: `[vitehub] Database "${database}" has two tables named ${JSON.stringify(sqlName)}:\n  - ${existing}\n  - ${part.owner}\nRename one table, or remove the contribution. If the Definition already lists the contributed tables, remove them from its schema.` })
      }
    }
    for (const sqlName of part.schema.sqlNames.values()) sqlNames.set(sqlName, part.owner)
  }
}

// drizzle-kit finds tables through named exports, so each table gets one.
function createTableExports(parts: SchemaPart[]) {
  let index = 0
  return parts.flatMap(part => part.schema.tableNames.flatMap((tableName) => {
    if (reservedSchemaExports.has(tableName)) {
      throw databaseErrorDiagnostics.DATABASE_B0009({ message: `[vitehub] ${part.owner} uses the reserved schema key ${JSON.stringify(tableName)}. Rename that table key.` })
    }
    const variable = `table_${index++}`
    return [
      `const ${variable} = ${part.expression}[${JSON.stringify(tableName)}]`,
      `export { ${variable} as ${renderExportName(tableName)} }`,
    ]
  }))
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition, parts: SchemaPart[], contributions: ResolvedDatabaseContribution[]) {
  const definitionVariable = "databaseDefinition"
  const schemaExpression = contributions.length
    ? `{ ${parts.map(part => `...${part.expression}`).join(", ")} }`
    : `${definitionVariable}.schema`
  return [
    `import ${definitionVariable} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    ...contributions.map((contribution, index) => renderContributionImport(file, contribution, `contributedSchema_${index}`)),
    "",
    ...createTableExports(parts),
    `export const schema = ${schemaExpression}`,
    "export default schema",
    "",
  ].join("\n")
}

async function writeGeneratedDrizzleSchema(config: ResolvedDBViteConfig, definition: DiscoveredDatabaseDefinition, options: DatabaseTableNameOptions) {
  const file = config.generatedSchemaFilesByDatabase[definition.name]!
  const contributions = config.tableContributionsByDatabase[definition.name] ?? []
  await mkdir(dirname(file), { recursive: true })
  const [schema, ...contributed] = await Promise.all([
    loadDatabaseSchema(definition.handler, options),
    ...contributions.map(contribution => loadContributedDatabaseSchema(contribution, file, options)),
  ])
  const parts: SchemaPart[] = [
    { expression: "databaseDefinition.schema", owner: `Database Definition "${definition.handler}"`, schema: schema! },
    ...contributions.map((contribution, index) => ({
      expression: `contributedSchema_${index}`,
      owner: `contributed tables ${describeDatabaseContribution(contribution)}`,
      schema: contributed[index]!,
    })),
  ]
  assertDistinctTables(definition.name, parts)
  await writeFile(file, renderGeneratedDrizzleSchema(file, definition, parts, contributions), "utf8")
}

function renderDbCredentials(database: ResolvedDrizzleDatabaseConfig) {
  const databaseId = renderConfigValueExpression(database.cloudflare?.databaseId)
  if (database.cloudflare?.http && databaseId) {
    return [
      "  driver: \"d1-http\",",
      "  dbCredentials: {",
      "    accountId: process.env[\"CLOUDFLARE_ACCOUNT_ID\"],",
      `    databaseId: ${databaseId},`,
      "    token: process.env[\"CLOUDFLARE_API_TOKEN\"],",
      "  },",
    ]
  }

  const url = renderConfigValueExpression(database.connection?.url)
  const authToken = renderConfigValueExpression(database.connection?.authToken)
  if (!url) return []
  return [
    "  dbCredentials: {",
    ...(authToken ? [`    authToken: ${authToken},`] : []),
    `    url: ${url},`,
    "  },",
  ]
}

function renderGeneratedDrizzleConfig(config: ResolvedDBViteConfig, databaseNames = config.databaseNames) {
  const schemaFiles = databaseNames.map(name => config.generatedSchemaFilesByDatabase[name]!)
  const database = config.databases[databaseNames[0]!]!
  const out = databaseNames.length === 1 ? database.migrationsDir : ".vitehub/database/migrations"
  return [
    "export default {",
    "  dialect: \"sqlite\",",
    ...renderDbCredentials(database),
    `  schema: ${JSON.stringify(schemaFiles)},`,
    `  out: ${JSON.stringify(out)},`,
    "}",
    "",
  ].join("\n")
}

function renderGeneratedDatabaseTypes(file: string, config: ResolvedDBViteConfig) {
  const { definitions } = config
  const imports = definitions.flatMap((definition, index) => [
    `import type database_${index} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    ...(config.tableContributionsByDatabase[definition.name] ?? []).map((contribution, contributionIndex) =>
      renderContributionImport(file, contribution, `contribution_${index}_${contributionIndex}`, true)),
  ])
  // Contributed tables never share a key with the Definition, so the intersection equals the merged schema.
  const schemaType = (definition: DiscoveredDatabaseDefinition, index: number) => [
    `typeof database_${index}.schema`,
    ...(config.tableContributionsByDatabase[definition.name] ?? []).map((_, contributionIndex) => `typeof contribution_${index}_${contributionIndex}`),
  ].join(" & ")
  const schemaDefinitionIndex = Math.max(0, definitions.findIndex(definition => definition.name === "default"))
  const registryEntries = definitions.flatMap((definition, index) => [
    `    ${JSON.stringify(definition.name)}: {`,
    `      schema: ${schemaType(definition, index)}`,
    "    },",
  ])
  const registryDeclarations = ["@vite-hub/database/drizzle", "vite-hub/database/drizzle"].flatMap(moduleName => [
    `declare module ${JSON.stringify(moduleName)} {`,
    "  interface DatabaseRegistry {",
    ...registryEntries,
    "  }",
    "}",
    "",
  ])

  return [
    ...imports,
    "",
    `type DefaultDatabaseSchema = ${definitions.length ? schemaType(definitions[schemaDefinitionIndex]!, schemaDefinitionIndex) : "{}"}`,
    "",
    'declare module "#vitehub/database/schema" {',
    "  interface DatabaseSchema extends DefaultDatabaseSchema {}",
    "}",
    "",
    ...registryDeclarations,
    "export {}",
    "",
  ].join("\n")
}

export async function removeGeneratedDatabaseTypes(rootDir: string) {
  const generatedTypesFile = join(rootDir, ".vitehub/types/database.d.ts")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, "export {}\n", "utf8")
}

/**
 * Writes generated schemas, Drizzle configs, and types. Each Database Definition and each contribution is loaded to
 * list its tables. Contributed tables join the schema of their target Database.
 */
export async function writeGeneratedDatabaseArtifacts(config: ResolvedDBViteConfig, options: DatabaseTableNameOptions = {}) {
  const generatedTypesFile = join(config.rootDir, ".vitehub/types/database.d.ts")
  await Promise.all(config.definitions.map(definition => writeGeneratedDrizzleSchema(config, definition, options)))

  await mkdir(dirname(config.generatedDrizzleConfigFile), { recursive: true })
  await writeFile(config.generatedDrizzleConfigFile, renderGeneratedDrizzleConfig(config), "utf8")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, renderGeneratedDatabaseTypes(generatedTypesFile, config), "utf8")
  await Promise.all(config.databaseNames.map(async (name) => {
    const file = config.generatedDrizzleConfigFilesByDatabase[name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleConfig(config, [name]), "utf8")
  }))
}
