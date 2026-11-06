interface RenderDatabaseRuntimeModuleOptions {
  chunkParametersImport: string
  createAgentDatabaseImport: string
  databaseEntries: string[]
  imports: string[]
}

export function renderDatabaseRuntimeModule(options: RenderDatabaseRuntimeModuleOptions): string {
  return [
    `import { createAgentDatabase, createDatabaseBindingLookup, defaultDatabaseNotConfiguredError } from ${JSON.stringify(options.createAgentDatabaseImport)}`,
    `export { chunkParameters } from ${JSON.stringify(options.chunkParametersImport)}`,
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
    "export function useDatabase(name) { return Object.hasOwn(databases, name) ? databases[name] : undefined }",
    "export const useDatabaseBinding = createDatabaseBindingLookup(databases)",
    "export const agentDb = createAgentDatabase(databases)",
    "export const db = databases.default.db",
    "export const schema = databases.default.schema",
    "",
  ].join("\n")
}
