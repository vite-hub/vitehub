import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, isAbsolute, join, relative } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"
import { describeDatabaseContribution } from "../contributions.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { assertDistinctLoadedSchemas, loadContributedDatabaseSchema, loadDatabaseSchema, mergeLoadedSchemas } from "./schema-tables.ts"

import type { ResolvedDatabaseContribution } from "../contributions.ts"
import type { DatabaseTableNameOptions, LoadedDatabaseSchema } from "./schema-tables.ts"
import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

const reservedSchemaExports = new Set(["default", "schema"])

function renderExportName(name: string) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

/** Imports a contribution from a generated file: absolute files relative to it, package specifiers as written. */
function contributionImportPath(file: string, contribution: ResolvedDatabaseContribution) {
  const { module } = contribution.definition
  return isAbsolute(module) ? createImportPath(file, module) : module
}

/** Renders the import of contributed tables into a generated module. */
export function renderContributionImport(file: string, contribution: ResolvedDatabaseContribution, variable: string, typeOnly = false) {
  const keyword = typeOnly ? "import type" : "import"
  const from = JSON.stringify(contributionImportPath(file, contribution))
  const exportName = contribution.definition.export
  return exportName === "default"
    ? `${keyword} ${variable} from ${from}`
    : `${keyword} { ${renderExportName(exportName)} as ${variable} } from ${from}`
}

/** Variables of the schema sources of a Definition. One source keeps the `single` name. */
function schemaSourceVariables(definition: DiscoveredDatabaseDefinition, single: string, prefix: string) {
  return definition.schemaSources.length === 1 ? [single] : definition.schemaSources.map((_, index) => `${prefix}${index}`)
}

interface SchemaPart {
  /** Expression that evaluates to the schema object. */
  expression: string
  owner: string
  schema: LoadedDatabaseSchema
  /** Expression of the object that holds each table. Defaults to `expression`. */
  tableSources?: Map<string, string>
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
      `const ${variable} = ${part.tableSources?.get(tableName) ?? part.expression}[${JSON.stringify(tableName)}]`,
      `export { ${variable} as ${renderExportName(tableName)} }`,
    ]
  }))
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition, parts: SchemaPart[], contributions: ResolvedDatabaseContribution[]) {
  const sourceVariables = schemaSourceVariables(definition, "databaseDefinition", "schemaSource_")
  const layered = sourceVariables.length > 1
  return [
    ...definition.schemaSources.map((source, index) => `import ${sourceVariables[index]} from ${JSON.stringify(createImportPath(file, source.handler))}`),
    ...contributions.map((contribution, index) => renderContributionImport(file, contribution, `contributedSchema_${index}`)),
    "",
    // Nuxt layers merge in order, so the application wins a key.
    ...layered ? [`const definitionSchema = { ${sourceVariables.map(variable => `...${variable}.schema`).join(", ")} }`] : [],
    ...createTableExports(parts),
    `export const schema = ${parts.length > 1 ? `{ ${parts.map(part => `...${part.expression}`).join(", ")} }` : parts[0]!.expression}`,
    "export default schema",
    "",
  ].join("\n")
}

async function writeGeneratedDrizzleSchema(config: ResolvedDBViteConfig, definition: DiscoveredDatabaseDefinition, options: DatabaseTableNameOptions) {
  const file = config.generatedSchemaFilesByDatabase[definition.name]!
  const contributions = config.tableContributionsByDatabase[definition.name] ?? []
  await mkdir(dirname(file), { recursive: true })
  const [sources, loadedContributions] = await Promise.all([
    Promise.all(definition.schemaSources.map(source => loadDatabaseSchema(source.handler, options))),
    Promise.all(contributions.map(async contribution => ({
      contribution,
      schema: await loadContributedDatabaseSchema(contribution, file, options),
    }))),
  ])
  // A failed contribution is intentionally omitted in non-strict mode. Its module cannot be imported by the
  // generated schema, while the fallback warning already explains that its tables are unavailable.
  // A Definition source that cannot load here stays: the host resolves its aliases and Nuxt auto-imports when it
  // imports the generated schema, and the fallback lists the keys of its literal `schema: { ... }` object.
  const activeContributions = loadedContributions.filter(item => item.schema.loaded)
  const sourceVariables = schemaSourceVariables(definition, "databaseDefinition", "schemaSource_")
  const contributed = activeContributions.map(item => item.schema)
  // Each table comes from the layer source that wins its key, so drizzle-kit sees every table once.
  const tableSources = new Map<string, string>()
  sources.forEach((source, index) => {
    for (const key of source.keys) tableSources.set(key, `${sourceVariables[index]}.schema`)
  })
  const parts: SchemaPart[] = [
    {
      expression: definition.schemaSources.length > 1 ? "definitionSchema" : "databaseDefinition.schema",
      owner: `Database Definition "${definition.handler}"`,
      schema: mergeLoadedSchemas(sources),
      tableSources,
    },
    ...activeContributions.map((item, index) => ({
      expression: `contributedSchema_${index}`,
      owner: `contributed tables ${describeDatabaseContribution(item.contribution)}`,
      schema: contributed[index]!,
    })),
  ]
  assertDistinctLoadedSchemas(definition.name, parts)
  await writeFile(file, renderGeneratedDrizzleSchema(file, definition, parts, activeContributions.map(item => item.contribution)), "utf8")
}

function renderDbCredentials(database: ResolvedDrizzleDatabaseConfig) {
  if (database.dialect === "postgresql") {
    const url = renderConfigValueExpression(database.connection?.url)
    return url ? ["  dbCredentials: {", `    url: ${url},`, "  },"] : []
  }

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

function renderGeneratedDrizzleConfig(file: string, config: ResolvedDBViteConfig, databaseNames = config.databaseNames) {
  if (databaseNames.length > 1) {
    // One Drizzle config has one set of credentials, one casing, and one migrations folder, so each Database needs its own.
    const configs = databaseNames.map(name => relative(config.rootDir, config.generatedDrizzleConfigFilesByDatabase[name]!)).join(", ")
    return [
      `throw new Error(${JSON.stringify(`[vitehub] This project has more than one Database. Run drizzle-kit once per Database with ${configs}, or run \`vitehub db generate\` and \`vitehub db migrate\`.`)})`,
      "",
    ].join("\n")
  }
  const database = config.databases[databaseNames[0]!]!
  const definition = config.definitions.find(item => item.name === database.name)!
  // Read Drizzle options from the Definition so migrations and queries use the same casing.
  return [
    `import databaseDefinition from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    "",
    "export default {",
    `  dialect: ${JSON.stringify(database.dialect)},`,
    "  casing: databaseDefinition.drizzle?.casing,",
    ...renderDbCredentials(database),
    `  schema: ${JSON.stringify([config.generatedSchemaFilesByDatabase[database.name]!])},`,
    `  out: ${JSON.stringify(database.migrationsDir)},`,
    "}",
    "",
  ].join("\n")
}

function renderSchemaType(variables: string[]) {
  const [first, ...rest] = variables.map(variable => `typeof ${variable}.schema`)
  if (!first) return "{}"
  return rest.reduce((merged, next) => `Omit<${merged}, keyof ${next}> & ${next}`, first)
}

function renderGeneratedDatabaseTypes(file: string, config: ResolvedDBViteConfig, loadedContributions: ReadonlyMap<string, readonly ResolvedDatabaseContribution[]>) {
  const { definitions } = config
  const variables = definitions.map((definition, index) => schemaSourceVariables(definition, `database_${index}`, `database_${index}_`))
  const imports = definitions.flatMap((definition, index) => [
    ...definition.schemaSources.map((source, sourceIndex) =>
      `import type ${variables[index]![sourceIndex]} from ${JSON.stringify(createImportPath(file, source.handler))}`),
    ...(loadedContributions.get(definition.name) ?? []).map((contribution, contributionIndex) =>
      renderContributionImport(file, contribution, `contribution_${index}_${contributionIndex}`, true)),
  ])
  // A later layer source replaces a key. Contributed tables never share a key with the Definition, so the
  // intersection equals the merged schema.
  const schemaType = (definition: DiscoveredDatabaseDefinition, index: number) => [
    renderSchemaType(variables[index]!),
    ...(loadedContributions.get(definition.name) ?? []).map((_, contributionIndex) => `typeof contribution_${index}_${contributionIndex}`),
  ].join(" & ")
  const schemaDefinitionIndex = Math.max(0, definitions.findIndex(definition => definition.name === "default"))
  const registryEntries = definitions.flatMap((definition, index) => [
    `    ${JSON.stringify(definition.name)}: {`,
    ...(config.databases[definition.name]?.dialect === "postgresql" ? ["      dialect: \"postgresql\""] : []),
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
  const loadedContributions = new Map<string, readonly ResolvedDatabaseContribution[]>()
  await Promise.all(config.definitions.map(async (definition) => {
    const contributions = config.tableContributionsByDatabase[definition.name] ?? []
    const loaded = await Promise.all(contributions.map(async contribution =>
      ({ contribution, schema: await loadContributedDatabaseSchema(contribution, config.generatedSchemaFilesByDatabase[definition.name]!, options) })))
    loadedContributions.set(definition.name, loaded.filter(item => item.schema.loaded).map(item => item.contribution))
  }))

  await mkdir(dirname(config.generatedDrizzleConfigFile), { recursive: true })
  await writeFile(config.generatedDrizzleConfigFile, renderGeneratedDrizzleConfig(config.generatedDrizzleConfigFile, config), "utf8")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, renderGeneratedDatabaseTypes(generatedTypesFile, config, loadedContributions), "utf8")
  await Promise.all(config.databaseNames.map(async (name) => {
    const file = config.generatedDrizzleConfigFilesByDatabase[name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleConfig(file, config, [name]), "utf8")
  }))
}
