interface RenderDatabaseRuntimeModuleOptions {
  chunkParametersImport: string
  createAgentDatabaseImport: string
  databaseEntries: string[]
  /** Module that exports `ensureDatabaseMigrations()`. */
  ensureMigrationsImport: string
  imports: string[]
  /** The module that exports `readPostgresConnectionUrl()`, for `getPostgresConnectionUrl()`. */
  postgresConnectionImport: string
  /** The module of shipped migrations, or why this build cannot apply migrations in the server process. */
  migrations: { import: string } | { unsupported: string }
  useDatabaseImport: string
}

export function renderDatabaseRuntimeModule(options: RenderDatabaseRuntimeModuleOptions): string {
  return [
    `import { createAgentDatabase, createDatabaseBindingLookup, defaultDatabaseNotConfiguredError } from ${JSON.stringify(options.createAgentDatabaseImport)}`,
    `import { createUseDatabase } from ${JSON.stringify(options.useDatabaseImport)}`,
    `export { chunkParameters } from ${JSON.stringify(options.chunkParametersImport)}`,
    `import { readPostgresConnectionUrl } from ${JSON.stringify(options.postgresConnectionImport)}`,
    `import { ensureDatabaseMigrations } from ${JSON.stringify(options.ensureMigrationsImport)}`,
    ...options.imports,
    "",
    "const configuredDatabases = {",
    ...options.databaseEntries,
    "}",
    "const defaultDatabase = configuredDatabases.default || {",
    "  db: new Proxy({}, {",
    "    get() { throw defaultDatabaseNotConfiguredError() },",
    "  }),",
    "  relations: {},",
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
    "import" in options.migrations
      // A dynamic import keeps the migration SQL out of the server start until a call needs it.
      ? `const loadMigrations = () => import(${JSON.stringify(options.migrations.import)}).then(module => module.default)`
      : `const loadMigrations = async () => (${JSON.stringify({ allowDataLoss: false, databases: {}, unsupported: options.migrations.unsupported })})`,
    "export function ensureMigrations(name) { return ensureDatabaseMigrations({ databases, load: loadMigrations }, name === undefined ? undefined : [name]) }",
    "",
  ].join("\n")
}
