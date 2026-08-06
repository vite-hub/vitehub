import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, join } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"

import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function createTableExports(definition: DiscoveredDatabaseDefinition, definitionVariable: string) {
  return definition.tableNames.map(tableName => `export const ${tableName} = ${definitionVariable}.schema[${JSON.stringify(tableName)}]`)
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition) {
  const definitionVariable = "databaseDefinition"
  return [
    `import ${definitionVariable} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    "",
    ...createTableExports(definition, definitionVariable),
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
  const namedEntries = definitions.flatMap((definition, index) => definition.name === "default" ? [] : [
    `    ${JSON.stringify(definition.name)}: {`,
    `      config: import("@vite-hub/database").ResolvedDrizzleDatabaseConfig`,
    `      schema: typeof database_${index}.schema`,
    "    },",
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
    'declare module "#vitehub/database/databases" {',
    "  interface DatabaseRegistry {",
    ...namedEntries,
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

export async function removeGeneratedDatabaseTypes(rootDir: string) {
  const generatedTypesFile = join(rootDir, ".vitehub/types/database.d.ts")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, "export {}\n", "utf8")
}

export async function writeGeneratedDatabaseArtifacts(config: ResolvedDBViteConfig) {
  const generatedTypesFile = join(config.rootDir, ".vitehub/types/database.d.ts")
  await Promise.all(config.definitions.map(async (definition) => {
    const file = config.generatedSchemaFilesByDatabase[definition.name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleSchema(file, definition), "utf8")
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
