import { mkdir, writeFile } from "node:fs/promises"

import { createImportPath } from "@vite-hub/internal/build/paths"
import { dirname, join, relative } from "pathe"

import { renderConfigValueExpression } from "../config-value.ts"
import { databaseErrorDiagnostics } from "../error-diagnostics.ts"
import type { DatabaseTableNameOptions, LoadedDatabaseSchema } from "./schema-tables.ts"
import type { DiscoveredDatabaseDefinition, ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

const reservedSchemaExports = new Set(["default", "schema"])

function renderExportName(name: string) {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

/** Variables of the schema sources of a Definition. One source keeps the `single` name. */
function schemaSourceVariables(definition: DiscoveredDatabaseDefinition, single: string, prefix: string) {
  return definition.schemaSources.length === 1 ? [single] : definition.schemaSources.map((_, index) => `${prefix}${index}`)
}

// drizzle-kit finds tables through named exports, so each table gets one.
function createTableExports(definition: DiscoveredDatabaseDefinition, tableNames: string[], tableSources: Map<string, string>) {
  return tableNames.flatMap((tableName, index) => {
    if (reservedSchemaExports.has(tableName)) {
      throw databaseErrorDiagnostics.DATABASE_B0009({ message: `[vitehub] Database Definition "${definition.handler}" uses the reserved schema key ${JSON.stringify(tableName)}. Rename that table key.` })
    }
    return [
      `const table_${index} = ${tableSources.get(tableName)}[${JSON.stringify(tableName)}]`,
      `export { table_${index} as ${renderExportName(tableName)} }`,
    ]
  })
}

/** Renders the schema of a Definition. With Nuxt layers, it imports each schema source and merges them. */
function renderGeneratedDrizzleSchema(file: string, definition: DiscoveredDatabaseDefinition, sources: LoadedDatabaseSchema[], mergeLoadedSchemas: (schemas: readonly LoadedDatabaseSchema[]) => LoadedDatabaseSchema) {
  const sourceVariables = schemaSourceVariables(definition, "databaseDefinition", "schemaSource_")
  const layered = sourceVariables.length > 1
  // Each table comes from the source that wins its key, so drizzle-kit sees every table once.
  const tableSources = new Map<string, string>()
  sources.forEach((source, index) => {
    for (const key of source.keys) tableSources.set(key, `${sourceVariables[index]}.schema`)
  })
  return [
    ...definition.schemaSources.map((source, index) => `import ${sourceVariables[index]} from ${JSON.stringify(createImportPath(file, source.handler))}`),
    "",
    // Nuxt layers merge in order, so the application wins a key.
    ...layered ? [`const definitionSchema = { ${sourceVariables.map(variable => `...${variable}.schema`).join(", ")} }`] : [],
    ...createTableExports(definition, mergeLoadedSchemas(sources).tableNames, tableSources),
    `export const schema = ${layered ? "definitionSchema" : "databaseDefinition.schema"}`,
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
    "  dialect: \"sqlite\",",
    "  casing: databaseDefinition.drizzle?.casing,",
    ...renderDbCredentials(database),
    `  schema: ${JSON.stringify([config.generatedSchemaFilesByDatabase[database.name]!])},`,
    `  out: ${JSON.stringify(database.migrationsDir)},`,
    "}",
    "",
  ].join("\n")
}

// A later layer source replaces a key, as in the merged runtime schema.
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

/** Writes generated schemas, Drizzle configs, and types. Each schema source of a Definition is loaded to list its tables. */
export async function writeGeneratedDatabaseArtifacts(config: ResolvedDBViteConfig, options: DatabaseTableNameOptions = {}) {
  const generatedTypesFile = join(config.rootDir, ".vitehub/types/database.d.ts")
  if (config.definitions.length) {
    // Keep Drizzle out of config resolution when no Definitions need evaluation. The loader is only needed while
    // writing generated schemas, and importing it eagerly would load request-time dependencies for every Vite config.
    const { loadDatabaseSchema, mergeLoadedSchemas } = await import("./schema-tables.ts")
    await Promise.all(config.definitions.map(async (definition) => {
      const file = config.generatedSchemaFilesByDatabase[definition.name]!
      const sources = await Promise.all(definition.schemaSources.map(source => loadDatabaseSchema(source.handler, options)))
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, renderGeneratedDrizzleSchema(file, definition, sources, mergeLoadedSchemas), "utf8")
    }))
  }

  await mkdir(dirname(config.generatedDrizzleConfigFile), { recursive: true })
  await writeFile(config.generatedDrizzleConfigFile, renderGeneratedDrizzleConfig(config.generatedDrizzleConfigFile, config), "utf8")
  await mkdir(dirname(generatedTypesFile), { recursive: true })
  await writeFile(generatedTypesFile, renderGeneratedDatabaseTypes(generatedTypesFile, config.definitions), "utf8")
  await Promise.all(config.databaseNames.map(async (name) => {
    const file = config.generatedDrizzleConfigFilesByDatabase[name]!
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, renderGeneratedDrizzleConfig(file, config, [name]), "utf8")
  }))
}
