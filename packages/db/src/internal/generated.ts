import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vitehub/internal/build/paths"
import { dirname } from "pathe"

import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig } from "../types.ts"

function createTableExports(definition: DiscoveredDatabaseDefinition, definitionVariable: string) {
  return definition.tableNames.map(tableName => `export const ${tableName} = ${definitionVariable}.tables[${JSON.stringify(tableName)}]`)
}

export function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition) {
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

export function renderGeneratedDrizzleConfig(config: ResolvedDBViteConfig) {
  const schemaFiles = config.databaseNames.map(name => config.generatedSchemaFilesByDatabase[name]!)
  const out = config.databaseNames.length === 1
    ? config.databases[config.databaseNames[0]!]!.migrationsDir
    : ".vitehub/db/migrations"
  return [
    "export default {",
    "  dialect: \"sqlite\",",
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
}
