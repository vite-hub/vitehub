import { existsSync, realpathSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { dirname, join, relative } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"

import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

function createTableExports(definition: DiscoveredDatabaseDefinition, definitionVariable: string) {
  return definition.tableNames.map(tableName => `export const ${tableName} = ${definitionVariable}.schema[${JSON.stringify(tableName)}]`)
}

function displayPath(rootDir: string, file: string) {
  const real = (path: string) => existsSync(path) ? realpathSync(path) : path
  return relative(real(rootDir), real(file))
}

function extensionSchemaType(variable: string) {
  return `Omit<typeof ${variable}, "default">`
}

function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition, extensions: string[], rootDir: string) {
  const definitionVariable = "databaseDefinition"
  const definitionImport = `import ${definitionVariable} from ${JSON.stringify(createImportPath(file, definition.handler))}`
  if (!extensions.length) {
    return [
      definitionImport,
      "",
      ...createTableExports(definition, definitionVariable),
      `export const schema = ${definitionVariable}.schema`,
      "export default schema",
      "",
    ].join("\n")
  }

  // Drizzle Kit reads tables from named exports, so extension files are re-exported as well as merged.
  const extensionImports = extensions.map(extension => JSON.stringify(createImportPath(file, extension)))
  const schemaType = [
    `typeof ${definitionVariable}.schema`,
    ...extensions.map((_extension, index) => extensionSchemaType(`extension_${index}`)),
  ].join(" & ")
  return [
    definitionImport,
    ...extensionImports.map((path, index) => `import * as extension_${index} from ${path}`),
    "",
    ...extensionImports.map(path => `export * from ${path}`),
    ...createTableExports(definition, definitionVariable),
    `export const schema = mergeDatabaseSchema(${JSON.stringify(definition.name)}, [`,
    `  [${JSON.stringify(displayPath(rootDir, definition.handler))}, ${definitionVariable}.schema, false],`,
    ...extensions.map((extension, index) => `  [${JSON.stringify(displayPath(rootDir, extension))}, extension_${index}, true],`),
    `]) as ${schemaType}`,
    "export default schema",
    "",
    "// Drizzle Kit inspects every export, so the merged schema keeps a normal prototype.",
    "function mergeDatabaseSchema(database: string, sources: Array<readonly [string, object, boolean]>): Record<string, unknown> {",
    "  const schema: Record<string, unknown> = {}",
    "  const owners: Record<string, string> = Object.create(null)",
    "  for (const [owner, tables, isModule] of sources) {",
    "    for (const [key, value] of Object.entries(tables)) {",
    "      if (isModule && key === \"default\") continue",
    "      if (key in owners && schema[key] !== value) {",
    "        throw new Error(`[vitehub] Database ${JSON.stringify(database)} schema key ${JSON.stringify(key)} is exported by both ${owners[key]} and ${owner}.`)",
    "      }",
    "      Object.defineProperty(schema, key, { configurable: true, enumerable: true, value, writable: true })",
    "      owners[key] = owner",
    "    }",
    "  }",
    "  return schema",
    "}",
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

function renderGeneratedDatabaseTypes(file: string, definitions: DiscoveredDatabaseDefinition[], extensionsByDatabase: Record<string, string[]>) {
  const extensionsOf = (definition: DiscoveredDatabaseDefinition | undefined) => (definition && extensionsByDatabase[definition.name]) || []
  const imports = definitions.flatMap((definition, index) => [
    `import type database_${index} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    ...extensionsOf(definition).map((extension, extensionIndex) =>
      `import type * as database_${index}_extension_${extensionIndex} from ${JSON.stringify(createImportPath(file, extension))}`),
  ])
  const schemaType = (index: number) => [
    `typeof database_${index}.schema`,
    ...extensionsOf(definitions[index]).map((_extension, extensionIndex) => extensionSchemaType(`database_${index}_extension_${extensionIndex}`)),
  ].join(" & ")
  const schemaDefinitionIndex = Math.max(0, definitions.findIndex(definition => definition.name === "default"))
  const registryEntries = definitions.flatMap((definition, index) => [
    `    ${JSON.stringify(definition.name)}: {`,
    `      schema: ${schemaType(index)}`,
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
    `type DefaultDatabaseSchema = ${schemaType(schemaDefinitionIndex)}`,
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
    await writeFileIfChanged(file, renderGeneratedDrizzleSchema(file, definition, config.schemaExtensionsByDatabase[definition.name] ?? [], config.rootDir))
  }))

  await mkdir(dirname(config.generatedDrizzleConfigFile), { recursive: true })
  await writeFile(config.generatedDrizzleConfigFile, renderGeneratedDrizzleConfig(config), "utf8")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, renderGeneratedDatabaseTypes(generatedTypesFile, config.definitions, config.schemaExtensionsByDatabase), "utf8")
  await Promise.all(config.databaseNames.map(async (name) => {
    const file = config.generatedDrizzleConfigFilesByDatabase[name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleConfig(config, [name]), "utf8")
  }))
}
