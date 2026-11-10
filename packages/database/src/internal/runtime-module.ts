interface RenderDatabaseRuntimeModuleOptions {
  chunkParametersImport: string
  createAgentDatabaseImport: string
  databaseEntries: string[]
  imports: string[]
  /** Statements that read the Database Definitions. They run on the first Database access, not when the module loads. */
  setup?: string[]
  useDatabaseImport: string
}

/**
 * Renders the runtime Database registry that Nuxt and hosted functions alias `@vite-hub/database/runtime/registry` to.
 * Database Definitions import `@vite-hub/database`, which re-exports this module, and this module imports the
 * Definitions. It reads them only on the first Database access, so the import cycle works in any load order.
 */
export function renderDatabaseRuntimeModule(options: RenderDatabaseRuntimeModuleOptions): string {
  return [
    `import { createAgentDatabase, defaultDatabaseNotConfiguredError } from ${JSON.stringify(options.createAgentDatabaseImport)}`,
    `import { createUseDatabase } from ${JSON.stringify(options.useDatabaseImport)}`,
    `export { chunkParameters } from ${JSON.stringify(options.chunkParametersImport)}`,
    ...options.imports,
    "",
    "let configuredDatabases",
    "function configured() {",
    "  if (configuredDatabases) return configuredDatabases",
    ...(options.setup ?? []).map(line => line ? `  ${line}` : line),
    "  configuredDatabases = {",
    ...options.databaseEntries.map(line => `  ${line}`),
    "  }",
    "  return configuredDatabases",
    "}",
    "let resolvedDatabases",
    "function resolved() {",
    "  resolvedDatabases ??= {",
    "    ...configured(),",
    "    default: configured().default || {",
    "      db: new Proxy({}, {",
    "        get() { throw defaultDatabaseNotConfiguredError() },",
    "      }),",
    "      schema: {},",
    "    },",
    "  }",
    "  return resolvedDatabases",
    "}",
    "function deferred(resolve, bindMethods) {",
    "  return new Proxy({}, {",
    "    get: (_, property) => {",
    "      const target = resolve()",
    "      const value = Reflect.get(target, property, target)",
    "      return bindMethods && typeof value === \"function\" ? value.bind(target) : value",
    "    },",
    "    getOwnPropertyDescriptor: (_, property) => {",
    "      const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), property)",
    "      return descriptor && { ...descriptor, configurable: true }",
    "    },",
    "    has: (_, property) => Reflect.has(resolve(), property),",
    "    ownKeys: () => Reflect.ownKeys(resolve()),",
    "  })",
    "}",
    "export const databases = deferred(resolved)",
    "export function useDatabase(name) {",
    "  return createUseDatabase(databases, Object.keys(configured()))(name)",
    "}",
    "export const agentDb = createAgentDatabase(databases)",
    "export const db = deferred(() => resolved().default.db, true)",
    "export const schema = deferred(() => resolved().default.schema)",
    "",
  ].join("\n")
}
