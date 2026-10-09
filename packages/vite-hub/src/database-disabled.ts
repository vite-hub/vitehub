import { discoverDatabaseDefinitions } from "@vite-hub/database/config"
import { VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

import type { ViteHubCliContributor, ViteHubCliFeature } from "@vite-hub/internal/cli"
import type { Plugin } from "vite"

const databasePluginName = "@vite-hub/database/vite"
const enableDatabase = "Set `database: true` in vitehub() to enable Database."

interface DisabledDatabaseState {
  /** Another integration, such as a direct hubDb() or the Database Nuxt module, provides Database. */
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
 * Features stay off until the application enables them. Without this plugin, the Drizzle runtime
 * resolves to an empty registry, so a build succeeds and the first query fails at runtime.
 * `runtimeImports` maps each import that Vite can resolve to its public specifier.
 */
export function databaseDisabledPlugin(runtimeImports: ReadonlyMap<string, string>, explicitlyDisabled = false): Plugin & { vitehub: { cli: () => ViteHubCliContributor | undefined } } {
  let serverDirs: string[] | undefined
  let state: DisabledDatabaseState | undefined

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
    resolveId(source, importer) {
      const specifier = runtimeImports.get(source)
      if (!specifier || !state || hasDatabasePlugin(state)) return
      throw viteHubErrorDiagnostics.VITE_HUB_B0013({
        message: `[vitehub] Database is disabled but ${importer ? JSON.stringify(importer) : "the application"} imports ${JSON.stringify(specifier)}. ${enableDatabase}`,
      })
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
              { description: "Unavailable while Database is disabled.", name: "generate", run },
              { description: "Unavailable while Database is disabled.", name: "migrate", run },
            ],
            name: "db",
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
  try {
    return discoverDatabaseDefinitions(state.root, { serverDirs: state.serverDirs }).length > 0
  }
  catch {
    // Invalid Definition layouts still show that the project defines a Database.
    return true
  }
}
