import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vitehub/internal/build/paths"
import { dirname } from "pathe"

import type { DatabaseConfigValue, DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function createTableExports(definition: DiscoveredDatabaseDefinition, definitionVariable: string) {
  return definition.tableNames.map(tableName => `export const ${tableName} = ${definitionVariable}.tables[${JSON.stringify(tableName)}]`)
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition) {
  const definitionVariable = "databaseDefinition"
  return [
    `import ${definitionVariable} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    "",
    ...createTableExports(definition, definitionVariable),
    `export const schema = ${definitionVariable}.tables`,
    "export default schema",
    "",
  ].join("\n")
}

function renderConfigValue(value: DatabaseConfigValue | undefined) {
  if (typeof value === "string") return JSON.stringify(value)
  const names = value?.source?.names ?? (value?.source?.name ? [value.source.name] : [])
  const expressions = names.map(name => `process.env[${JSON.stringify(name)}]`)
  return expressions.length ? expressions.join(" ?? ") : undefined
}

function renderDbCredentials(database: ResolvedDrizzleDatabaseConfig) {
  const url = renderConfigValue(database.connection?.url)
  const authToken = renderConfigValue(database.connection?.authToken)
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
  const out = databaseNames.length === 1 ? database.migrationsDir : ".vitehub/db/migrations"
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

export async function writeGeneratedDatabaseArtifacts(config: ResolvedDBViteConfig) {
  await Promise.all(config.definitions.map(async (definition) => {
    const file = config.generatedSchemaFilesByDatabase[definition.name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleSchema(file, definition), "utf8")
  }))

  await mkdir(dirname(config.generatedDrizzleConfigFile), { recursive: true })
  await writeFile(config.generatedDrizzleConfigFile, renderGeneratedDrizzleConfig(config), "utf8")
  await Promise.all(config.databaseNames.map(async (name) => {
    const file = config.generatedDrizzleConfigFilesByDatabase[name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleConfig(config, [name]), "utf8")
  }))
}
