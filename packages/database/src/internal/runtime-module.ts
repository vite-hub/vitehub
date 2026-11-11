interface RenderDatabaseRuntimeModuleOptions {
  chunkParametersImport: string
  createAgentDatabaseImport: string
  databaseEntries: string[]
  imports: string[]
  /** The module that exports `readPostgresConnectionUrl()`, for `getPostgresConnectionUrl()`. */
  postgresConnectionImport: string
  useDatabaseImport: string
}

export function renderDatabaseRuntimeModule(options: RenderDatabaseRuntimeModuleOptions): string {
  return [
    `import { createAgentDatabase, createDatabaseBindingLookup, defaultDatabaseNotConfiguredError } from ${JSON.stringify(options.createAgentDatabaseImport)}`,
    `import { createUseDatabase } from ${JSON.stringify(options.useDatabaseImport)}`,
    `export { chunkParameters } from ${JSON.stringify(options.chunkParametersImport)}`,
    `import { readPostgresConnectionUrl } from ${JSON.stringify(options.postgresConnectionImport)}`,
    ...options.imports,
    "",
    "const configuredDatabases = {",
    ...options.databaseEntries,
    "}",
    "const defaultDatabase = configuredDatabases.default || {",
    "  db: new Proxy({}, {",
    "    get() { throw defaultDatabaseNotConfiguredError() },",
    "  }),",
    "  schema: {},",
    "}",
    "export const databases = { ...configuredDatabases, default: defaultDatabase }",
    "export const useDatabase = createUseDatabase(databases, Object.keys(configuredDatabases))",
    "export const useDatabaseBinding = createDatabaseBindingLookup(databases)",
    "export const agentDb = createAgentDatabase(databases)",
    "export const db = databases.default.db",
    "export const schema = databases.default.schema",
    // The same exports as `@vite-hub/database/drizzle`, which this module stands in for.
    "export function getPostgresConnectionUrl(name = \"default\") { return readPostgresConnectionUrl(databases, name) }",
    "",
  ].join("\n")
}
