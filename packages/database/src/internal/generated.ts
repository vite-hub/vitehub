import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, join } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import { loadDatabaseTableNames } from "./schema-tables.ts"

import type { DatabaseTableNameOptions } from "./schema-tables.ts"
import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

const reservedSchemaExports = new Set(["default", "schema"])

function renderExportName(name: string) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

// drizzle-kit finds tables through named exports, so each table gets one.
function createTableExports(definition: DiscoveredDatabaseDefinition, tableNames: string[], definitionVariable: string) {
  return tableNames.flatMap((tableName, index) => {
    if (reservedSchemaExports.has(tableName)) {
      throw databaseErrorDiagnostics.DATABASE_B0009({ message: `[vitehub] Database Definition "${definition.handler}" uses the reserved schema key ${JSON.stringify(tableName)}. Rename that table key.` })
    }
    return [
      `const table_${index} = ${definitionVariable}.schema[${JSON.stringify(tableName)}]`,
      `export { table_${index} as ${renderExportName(tableName)} }`,
    ]
  })
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition, tableNames: string[]) {
  const definitionVariable = "databaseDefinition"
  return [
    `import ${definitionVariable} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    "",
    ...createTableExports(definition, tableNames, definitionVariable),
    `export const schema = ${definitionVariable}.schema`,
    "export default schema",
    "",
  ].join("\n")
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

function renderGeneratedDatabaseTypes(file: string, definitions: DiscoveredDatabaseDefinition[]) {
  const imports = definitions.map((definition, index) =>
    `import type database_${index} from ${JSON.stringify(createImportPath(file, definition.handler))}`)
  const schemaDefinitionIndex = Math.max(0, definitions.findIndex(definition => definition.name === "default"))
  const registryEntries = definitions.flatMap((definition, index) => [
    `    ${JSON.stringify(definition.name)}: {`,
    `      schema: typeof database_${index}.schema`,
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
    `type DefaultDatabaseSchema = typeof database_${schemaDefinitionIndex}.schema`,
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

/** Writes generated schemas, Drizzle configs, and types. Each Database Definition is loaded to list its tables. */
export async function writeGeneratedDatabaseArtifacts(config: ResolvedDBViteConfig, options: DatabaseTableNameOptions = {}) {
  const generatedTypesFile = join(config.rootDir, ".vitehub/types/database.d.ts")
  await Promise.all(config.definitions.map(async (definition) => {
    const file = config.generatedSchemaFilesByDatabase[definition.name]!
    const tableNames = await loadDatabaseTableNames(definition.handler, options)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleSchema(file, definition, tableNames), "utf8")
  }))

  await mkdir(dirname(config.generatedDrizzleConfigFile), { recursive: true })
  await writeFile(config.generatedDrizzleConfigFile, renderGeneratedDrizzleConfig(config), "utf8")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, renderGeneratedDatabaseTypes(generatedTypesFile, config.definitions), "utf8")
  await Promise.all(config.databaseNames.map(async (name) => {
    const file = config.generatedDrizzleConfigFilesByDatabase[name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleConfig(config, [name]), "utf8")
  }))
}
