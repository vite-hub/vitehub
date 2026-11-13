import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BlobStoreConfig } from "@vite-hub/blob"
import type { KVStoreConfig } from "@vite-hub/kv"
import type { ViteHubOptions } from "./plugins.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { requireOptionalOwner } from "./internal/optional-owners.ts"
import { ownerModules } from "./internal/owner-modules.ts"
import { isDefaultAgentJournal } from "./agent-invocations-setting.ts"

/** An explicit Node data directory selects local storage; the host owns durability. */
export function withDataDir(options: ViteHubOptions): ViteHubOptions {
  if (options.dataDir === undefined) return options
  if (typeof options.dataDir !== "string" || !options.dataDir.trim()) throw viteHubErrorDiagnostics.VITE_HUB_R0121({ message: "[vitehub] dataDir must be a non-empty directory path." })
  if (options.host !== "node") throw viteHubErrorDiagnostics.VITE_HUB_R0120({ message: "[vitehub] dataDir requires the node host and a persistent filesystem. Configure remote stores for other hosts." })
  const root = resolve(options.dataDir)
  const file = (name: string) => pathToFileURL(join(root, name)).href
  const kvStore = (store: KVStoreConfig, name?: string): KVStoreConfig => store.driver === "fs-lite"
    ? { ...store, base: store.base ?? join(root, "kv", ...(name ? [name] : [])) }
    : store
  const blobStore = (store: BlobStoreConfig, name?: string): BlobStoreConfig => store.driver === "fs"
    ? { ...store, base: store.base ?? join(root, "blob", ...(name ? [name] : [])) }
    : store
  const kv = options.kv === true ? { driver: "fs-lite" as const } : options.kv
  const cache = options.cache === true || (options.cache && options.cache.driver === "fs-lite" && !options.cache.base)
    ? { driver: "fs-lite" as const, base: join(root, "cache") }
    : options.cache
  const blob = options.blob === true ? { driver: "fs" as const } : options.blob
  const agent = options.agent === true ? {} : options.agent
  const state = agent && agent.providers?.state
  return {
    ...options,
    ...(cache ? { cache } : {}),
    dataDir: root,
    ...(kv ? { kv: Object.hasOwn(kv, "stores")
      ? { ...kv, stores: Object.fromEntries(Object.entries((kv as { stores: Record<string, KVStoreConfig> }).stores).map(([name, store]) => [name, kvStore(store, name)])) }
      : kvStore(kv as KVStoreConfig) } : {}),
    ...(blob ? { blob: Object.hasOwn(blob, "stores")
      ? { ...blob, stores: Object.fromEntries(Object.entries((blob as { stores: Record<string, BlobStoreConfig> }).stores).map(([name, store]) => [name, blobStore(store, name)])) }
      : !(blob as { driver?: string }).driver || (blob as { driver?: string }).driver === "fs" ? { ...blob, driver: "fs" as const, base: Object.hasOwn(blob, "base") ? (blob as { base?: string }).base ?? join(root, "blob") : join(root, "blob") } : blob } : {}),
    ...(agent ? {
      agent: {
        ...agent,
        ...(state !== false && (!state?.driver || ["auto", "sqlite", "libsql"].includes(state.driver)) ? {
          providers: { ...agent.providers, state: { ...state, driver: state?.driver ?? "libsql", url: state?.url ?? file("agent-state.sqlite") } },
        } : {}),
        ...(isDefaultAgentJournal(agent.invocations) ? {
          invocations: { ...agent.invocations, databaseUrl: agent.invocations?.databaseUrl ?? file("agent-invocations.sqlite") },
        } : {}),
      },
    } : {}),
    ...(options.workspace ? { workspace: {
      ...(options.workspace === true ? {} : options.workspace),
      root: (options.workspace === true ? undefined : options.workspace.root) ?? join(root, "workspaces"),
    } } : {}),
  }
}

/**
 * The D1 binding of the Database primitive on Cloudflare, where the default Agent Invocation journal lives.
 * Read the binding of the default or only Database Definition before integration defaults.
 */
export function defaultDatabaseD1Binding(
  host: string,
  database: ViteHubOptions["database"],
  definitions?: {
    /** Use the implicit default Database when the app has no Database Definition, as the Vite Database plugin does. */
    implicitDefault?: boolean
    root: string
    serverDirs?: string[]
  },
): string | undefined {
  if (host !== "cloudflare" || !database) return
  if (!definitions) return
  const { isImplicitDefaultDatabase, resolveDBViteConfig, resolveDefaultDatabase } = requireOptionalOwner(ownerModules.databaseConfig, "database")
  const options = database === true ? undefined : database
  const root = resolve(definitions.root, options?.projectRoot ?? ".")
  const serverDirs = options?.projectRoot !== undefined ? [resolve(root, "server")] : definitions.serverDirs
  const config = resolveDBViteConfig(options, root, { implicitDefault: definitions.implicitDefault, serverDirs })
  const target = resolveDefaultDatabase(config?.databaseNames ?? [])
  if (target.status !== "resolved") return
  // The implicit default Database has no Definition binding, so use it only when its D1 database resolves.
  const definition = config?.definitions.find(item => item.name === target.name)
  if (definition && isImplicitDefaultDatabase(definition)) return config?.definitionDefaults.cloudflareProjections[target.name]?.binding
  return config?.databases[target.name]?.cloudflare?.binding
    ?? (options?.driver === "d1" ? options.binding?.trim() || "DB" : undefined)
}

/**
 * The `comments` option turns Comments on. It keeps threads in the Database, so it enables `database` when it is unset.
 * `database: false` with Comments on fails. The Console does not turn Comments on.
 */
export function withComments(options: ViteHubOptions): ViteHubOptions {
  if (!options.comments) return options
  if (options.database === false) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0018({ message: "[vitehub] Comments keeps its threads in the Database, and the `comments` option turns Comments on, but `database` is false. Remove `database: false`, or set `comments: false`." })
  }
  return { ...options, database: options.database ?? true }
}

/**
 * Connections store grants and activity in the default Database, so they enable `database` when it is unset.
 * `database: false` with `connections` fails.
 */
export function withConnectionsDatabase(options: ViteHubOptions): ViteHubOptions {
  if (!options.connections) return options
  if (options.database === false) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0124({ message: "[vitehub] connections requires database because grants and activity are stored in the app database. Remove `database: false`." })
  }
  return options.database ? options : { ...options, database: true }
}
