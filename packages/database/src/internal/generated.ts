import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, join } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"

import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

/** Exports each table key from the source that wins it, so Drizzle Kit sees every table once. */
function createTableExports(definition: DiscoveredDatabaseDefinition, sourceVariables: string[]) {
  const winners = new Map<string, string>()
  definition.schemaSources.forEach((source, index) => {
    for (const tableName of source.tableNames) winners.set(tableName, sourceVariables[index]!)
  })
  return definition.tableNames.map(tableName => `export const ${tableName} = ${winners.get(tableName)}.schema[${JSON.stringify(tableName)}]`)
}

function schemaSourceVariables(definition: DiscoveredDatabaseDefinition, single: string, prefix: string) {
  return definition.schemaSources.length === 1 ? [single] : definition.schemaSources.map((_, index) => `${prefix}${index}`)
}

function renderSchemaExpression(sourceVariables: string[]) {
  return sourceVariables.length === 1
    ? `${sourceVariables[0]}.schema`
    : `{ ${sourceVariables.map(variable => `...${variable}.schema`).join(", ")} }`
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition) {
  const sourceVariables = schemaSourceVariables(definition, "databaseDefinition", "schemaSource_")
  return [
    ...definition.schemaSources.map((source, index) => `import ${sourceVariables[index]} from ${JSON.stringify(createImportPath(file, source.handler))}`),
    "",
    ...createTableExports(definition, sourceVariables),
    `export const schema = ${renderSchemaExpression(sourceVariables)}`,
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

function renderSchemaType(variables: string[]) {
  const [first, ...rest] = variables.map(variable => `typeof ${variable}.schema`)
  return rest.reduce((merged, next) => `Omit<${merged}, keyof ${next}> & ${next}`, first!)
}

function renderGeneratedDatabaseTypes(file: string, definitions: DiscoveredDatabaseDefinition[]) {
  const variables = definitions.map((definition, index) => schemaSourceVariables(definition, `database_${index}`, `database_${index}_`))
  const imports = definitions.flatMap((definition, index) => definition.schemaSources.map((source, sourceIndex) =>
    `import type ${variables[index]![sourceIndex]} from ${JSON.stringify(createImportPath(file, source.handler))}`))
  const schemaTypes = variables.map(renderSchemaType)
  const schemaDefinitionIndex = Math.max(0, definitions.findIndex(definition => definition.name === "default"))
  const registryEntries = definitions.flatMap((definition, index) => [
    `    ${JSON.stringify(definition.name)}: {`,
    `      schema: ${schemaTypes[index]}`,
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
    `type DefaultDatabaseSchema = ${schemaTypes[schemaDefinitionIndex]}`,
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
