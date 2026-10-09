import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveDBViteConfig } from "@vite-hub/database/config"
import type { BlobStoreConfig } from "@vite-hub/blob"
import type { KVStoreConfig } from "@vite-hub/kv"
import type { ViteHubOptions } from "./index.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

/** An explicit Node data directory selects local storage; the host owns durability. */
export function withDataDir(options: ViteHubOptions): ViteHubOptions {
  if (options.dataDir === undefined) return options
  if (options.preset !== "node") throw viteHubErrorDiagnostics.VITE_HUB_R0120({ message: "[vitehub] dataDir requires the node preset and a persistent filesystem. Configure remote stores for other hosts." })
  if (!options.dataDir.trim()) throw viteHubErrorDiagnostics.VITE_HUB_R0121({ message: "[vitehub] dataDir must be a non-empty directory path." })
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
    ...(kv ? { kv: "stores" in kv
      ? { ...kv, stores: Object.fromEntries(Object.entries(kv.stores).map(([name, store]) => [name, kvStore(store, name)])) }
      : kvStore(kv) } : {}),
    ...(blob ? { blob: "stores" in blob
      ? { ...blob, stores: Object.fromEntries(Object.entries(blob.stores).map(([name, store]) => [name, blobStore(store, name)])) }
      : !blob.driver || blob.driver === "fs" ? { ...blob, driver: "fs" as const, base: "base" in blob ? blob.base ?? join(root, "blob") : join(root, "blob") } : blob } : {}),
    ...(agent && state !== false && (!state?.provider || ["auto", "sqlite", "libsql"].includes(state.provider)) ? {
      agent: { ...agent, providers: { ...agent.providers, state: { ...state, provider: state?.provider ?? "libsql", url: state?.url ?? file("agent-state.sqlite") } } },
    } : {}),
    ...(options.console && options.console !== true ? { console: {
      ...options.console,
      databaseUrl: options.console.databaseUrl ?? file("console.sqlite"),
      ...(options.console.access === "auth" && options.console.auth && "provider" in options.console.auth && options.console.auth.provider === "github" ? { auth: {
        ...options.console.auth,
        databasePath: options.console.auth.databasePath ?? join(root, "console-auth.sqlite"),
      } } : {}),
    } } : {}),
    ...(options.workspace ? { workspace: {
      ...(options.workspace === true ? {} : options.workspace),
      root: (options.workspace === true ? undefined : options.workspace.root) ?? join(root, "workspaces"),
    } } : {}),
  }
}

/** Where the Console stores Agent invocations when no Agent Definition configures a journal. */
export type ConsoleJournal = { databaseUrl: string } | { d1Binding: string }

/**
 * The D1 binding of the Database primitive on Cloudflare.
 * Read the binding of the default or only Database Definition before integration defaults.
 */
export function consoleD1Binding(
  preset: string,
  database: ViteHubOptions["database"],
  definitions?: { root: string, serverDirs?: string[] },
): string | undefined {
  if (preset !== "cloudflare" || !database) return
  if (!definitions) return
  const options = database === true ? undefined : database
  const root = resolve(definitions.root, options?.projectRoot ?? ".")
  const serverDirs = options?.projectRoot !== undefined ? [resolve(root, "server")] : definitions.serverDirs
  const config = resolveDBViteConfig(options, root, { serverDirs })
  const name = config?.databases.default ? "default" : config?.databaseNames.length === 1 ? config.databaseNames[0] : undefined
  if (!name) return
  return config?.databases[name]?.cloudflare?.binding
    ?? (options?.driver === "d1" ? options.binding?.trim() || "DB" : undefined)
}

/** An explicit libSQL URL wins. Production builds use the D1 binding. Development keeps the local libSQL file. */
export function resolveConsoleJournal(databaseUrl: string | undefined, d1Binding: string | undefined, build: boolean): ConsoleJournal | undefined {
  if (databaseUrl) return { databaseUrl }
  if (build && d1Binding) return { d1Binding }
}

/** Resolve the journal path without changing the development-only Console shorthand. */
export function consoleDatabaseUrl(options: ViteHubOptions): string | undefined {
  if (!options.console) return undefined
  return (options.console === true ? undefined : options.console.databaseUrl)
    ?? (options.dataDir ? pathToFileURL(resolve(options.dataDir, "console.sqlite")).href : undefined)
}
