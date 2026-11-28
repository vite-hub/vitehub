import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { ownerModules } from "./internal/owner-modules.ts"

import type { ViteHubCliContributor, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const databasePluginName = "@vite-hub/database/vite"
const disabledWorkspaceDatabaseId = "\0vite-hub/workspace-database-disabled"

interface DisabledDatabaseState {
  /** Another integration, such as a direct hubDatabase() or the Database Nuxt module, provides Database. */
  databasePlugin?: DatabasePlugin
  databaseOption?: unknown
  explicitlyDisabled: boolean
  root: string
  serverDirs?: string[]
}

interface DatabasePlugin {
  name?: string
  api?: { getConfig?: () => unknown; isEnabled?: () => boolean }
}

/**
 * Reports Database use while `vitehub({ database })` is off.
 *
 * Database stays off until a Definition in `server/databases/` or the `database` option turns it on. Without this
 * plugin, the Drizzle runtime resolves to an empty registry, so a build succeeds and the first query fails at runtime.
 * `runtimeImports` maps each import that Vite can resolve to its public specifier.
 */
export function databaseDisabledPlugin(runtimeImports: ReadonlyMap<string, string>, explicitlyDisabled = false, workspaceStoreEntry?: string): Plugin & { vitehub: { cli: () => ViteHubCliContributor | undefined } } {
  const enableDatabase = explicitlyDisabled
    ? "Remove `database: false` from vitehub() to enable Database."
    : "Add a Database Definition in `server/databases/`, or set `database: true` in vitehub(), to enable Database."
  let serverDirs: string[] | undefined
  let state: DisabledDatabaseState | undefined
  const runtimeImportIds = new RegExp(`^(?:${[...runtimeImports.keys()].map(id => id.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")).join("|")})$`)

  return {
    name: "vite-hub/database-disabled",
    enforce: "pre",
    config(config) {
      // SAFETY: ViteHub hosts add this private server-directory symbol before plugins read the config.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    configResolved(config) {
      state = {
        // SAFETY: ViteHub attaches the effective database option to the resolved Vite config.
        databaseOption: (config as typeof config & { database?: unknown }).database,
        explicitlyDisabled,
        // SAFETY: The guard only reads the optional name and API exposed by Vite plugins.
        databasePlugin: config.plugins.find(plugin => plugin.name === databasePluginName) as DatabasePlugin | undefined,
        root: config.root,
        serverDirs,
      }
    },
    resolveId: {
      filter: { id: runtimeImportIds },
      handler(source, importer) {
        const specifier = runtimeImports.get(source)
        if (!specifier || !state || hasDatabasePlugin(state)) return
        if (importer && importer === workspaceStoreEntry && source === "@vite-hub/database/runtime/registry") return disabledWorkspaceDatabaseId
        throw viteHubErrorDiagnostics.VITE_HUB_B0013({
          message: `[vitehub] Database is disabled but ${importer ? JSON.stringify(importer) : "the application"} imports ${JSON.stringify(specifier)}. ${enableDatabase}`,
        })
      },
    },
    load: {
      filter: { id: /^\0vite-hub\/workspace-database-disabled$/ },
      handler() {
        return `export function useDatabase() { throw Object.assign(new Error(${JSON.stringify(`[vitehub] Database is disabled. ${enableDatabase}`)}), { code: "VITE_HUB_B0013" }) }`
      },
    },
    vitehub: {
      cli: () => {
        if (!state || hasDatabasePlugin(state) || !hasDatabaseDefinitions(state)) return
        const run: ViteHubCliFeature["run"] = (_args, { stderr }) => {
          stderr.write(`[vitehub] Database is disabled, so ViteHub ignores the discovered Database Definitions. ${enableDatabase}\n`)
          return 1
        }
        return {
          namespaces: [{
            description: `Database is disabled. ${enableDatabase}`,
            features: [
              { description: "Unavailable while Database is disabled.", name: "export", run },
              { description: "Unavailable while Database is disabled.", name: "generate", run },
              { description: "Unavailable while Database is disabled.", name: "migrate", run },
            ],
            name: "database",
          }],
        }
      },
    },
  }
}

function hasDatabasePlugin(state: DisabledDatabaseState): boolean {
  if (!state.databasePlugin) return false
  if (state.explicitlyDisabled) return false
  return state.databasePlugin.api?.isEnabled?.() ?? state.databaseOption !== false
}

function hasDatabaseDefinitions(state: DisabledDatabaseState): boolean {
  // Without the Database package, the app has no Database Definitions to ignore.
  const databaseConfig = ownerModules.databaseConfig
  if (!databaseConfig) return false
  try {
    return databaseConfig.discoverDatabaseDefinitions(state.root, { serverDirs: state.serverDirs }).length > 0
  }
  catch {
    // Invalid Definition layouts still show that the project defines a Database.
    return true
  }
}
