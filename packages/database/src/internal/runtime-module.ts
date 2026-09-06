interface RenderDatabaseRuntimeModuleOptions {
  createAgentDatabaseImport: string
  databaseEntries: string[]
  imports: string[]
}

export function renderDatabaseRuntimeModule(options: RenderDatabaseRuntimeModuleOptions): string {
  return [
    `import { createAgentDatabase, defaultDatabaseNotConfiguredError } from ${JSON.stringify(options.createAgentDatabaseImport)}`,
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
    "export function useDatabase(name) { return databases[name] }",
    "export const agentDb = createAgentDatabase(databases)",
    "export const db = databases.default.db",
    "export const schema = databases.default.schema",
    "",
  ].join("\n")
}
