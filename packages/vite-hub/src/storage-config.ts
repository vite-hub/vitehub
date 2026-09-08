import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BlobStoreConfig } from "@vite-hub/blob"
import type { KVStoreConfig } from "@vite-hub/kv"
import type { ViteHubOptions } from "./index.ts"

/** An explicit Node data directory selects local storage; the host owns durability. */
export function withDataDir(options: ViteHubOptions): ViteHubOptions {
  if (options.dataDir === undefined) return options
  if (options.preset !== "node") throw new TypeError("[vitehub] dataDir requires the node preset and a persistent filesystem. Configure remote stores for other hosts.")
  if (!options.dataDir.trim()) throw new TypeError("[vitehub] dataDir must be a non-empty directory path.")
  const root = resolve(options.dataDir)
  const file = (name: string) => pathToFileURL(join(root, name)).href
  const kvStore = (store: KVStoreConfig, name?: string): KVStoreConfig => store.driver === "fs-lite"
    ? { ...store, base: store.base ?? join(root, "kv", ...(name ? [name] : [])) }
    : store
  const blobStore = (store: BlobStoreConfig, name?: string): BlobStoreConfig => store.driver === "fs"
    ? { ...store, base: store.base ?? join(root, "blob", ...(name ? [name] : [])) }
    : store
  const kv = options.kv === true ? { driver: "fs-lite" as const } : options.kv
  const blob = options.blob === true ? { driver: "fs" as const } : options.blob
  const agent = options.agent === true ? {} : options.agent
  const state = agent && agent.providers?.state
  return {
    ...options,
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
    ...(options.console ? { console: {
      ...(options.console === true ? { access: "auth" as const } : options.console),
      databaseUrl: (options.console === true ? undefined : options.console.databaseUrl) ?? file("console.sqlite"),
    } } : {}),
    ...(options.workspace ? { workspace: {
      ...(options.workspace === true ? {} : options.workspace),
      root: (options.workspace === true ? undefined : options.workspace.root) ?? join(root, "workspaces"),
    } } : {}),
  }
}
