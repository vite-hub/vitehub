import { defu } from "defu"

import { readEnv, trimmed } from "@vite-hub/internal/env"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"
import { hasUpstashEnv, resolveUpstashStore } from "./integrations/upstash.ts"

import type {
  CloudflareKVStoreConfig,
  DenoKVStoreConfig,
  FsLiteKVStoreConfig,
  InferredKVStoreConfig,
  KVModuleOptions,
  KVStoreConfig,
  KVStoresConfig,
  ResolvedCloudflareKVStoreConfig,
  ResolvedDenoKVStoreConfig,
  ResolvedFsLiteKVStoreConfig,
  ResolvedKVModuleOptions,
  ResolvedKVStoreConfig,
} from "./types.ts"
import { kvErrorDiagnostics } from "./error-diagnostics.ts"

export interface KVResolutionInput {
  /**
   * `vite dev`. A store is then local unless it sets `remote: true`: inference never selects Upstash, and a Cloudflare
   * store falls back to `fs-lite` when the runtime has no binding. Builds leave it unset.
   */
  dev?: boolean
  env?: Record<string, string | undefined>
  hosting?: string
}

/** Where a Cloudflare KV store keeps its keys in `vite dev` when the runtime has no binding. */
export function cloudflareKVLocalBase(binding: string): string {
  return `.vitehub/data/kv-cloudflare/${binding}`
}

function readRemote(config: KVStoreConfig | InferredKVStoreConfig, store: string): boolean | undefined {
  const remote: unknown = Reflect.get(config, "remote")
  if (remote === undefined || typeof remote === "boolean") return remote
  throw kvErrorDiagnostics.KV_INVALID_REMOTE({ store })
}

/** Applies `vite dev` mode: hosted stores are marked remote, and a Cloudflare store gets its local fallback. */
function resolveDevStore(store: ResolvedKVStoreConfig, remote: boolean | undefined): ResolvedKVStoreConfig {
  if (store.driver === "upstash") return { ...store, remote: true }
  if (store.driver !== "cloudflare-kv-binding") return store
  return remote ? { ...store, remote: true } : { ...store, localBase: cloudflareKVLocalBase(store.binding) }
}

function resolveFsLiteStore(config: Partial<FsLiteKVStoreConfig> = {}): ResolvedFsLiteKVStoreConfig {
  return defu({ base: trimmed(config.base) }, { driver: "fs-lite" as const, base: ".vitehub/data/kv" })
}

function resolveCloudflareStore(
  config: Partial<CloudflareKVStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareKVStoreConfig {
  return defu(
    {
      binding: trimmed(config.binding),
      namespaceId: trimmed(config.namespaceId) ?? readEnv(env, "KV_NAMESPACE_ID"),
      namespaceName: trimmed(config.namespaceName),
    },
    { driver: "cloudflare-kv-binding" as const, binding: "KV" },
  )
}

function resolveDenoStore(config: Partial<DenoKVStoreConfig> = {}): ResolvedDenoKVStoreConfig {
  const path = trimmed(config.path)
  return path ? { driver: "deno-kv", path } : { driver: "deno-kv" }
}

function resolveExplicitStore(store: KVStoreConfig, env: Record<string, string | undefined>, name: string, dev: boolean | undefined): ResolvedKVStoreConfig {
  const remote = readRemote(store, name)
  const { driver } = store
  if ((remote === true && (driver === "fs-lite" || driver === "deno-kv")) || (remote === false && driver === "upstash")) {
    throw kvErrorDiagnostics.KV_REMOTE_CONFLICT({ driver, remote, store: name })
  }
  const resolved = resolveStoreDriver(store, env)
  return dev ? resolveDevStore(resolved, remote) : resolved
}

function resolveStoreDriver(store: KVStoreConfig, env: Record<string, string | undefined>): ResolvedKVStoreConfig {
  switch (store.driver) {
    case "cloudflare-kv-binding": return resolveCloudflareStore(store, env)
    case "deno-kv": return resolveDenoStore(store)
    case "upstash": return resolveUpstashStore(store)
    case "fs-lite": return resolveFsLiteStore(store)
    // SAFETY: The invalid driver branch reads only the driver field for diagnostics, without using it as a supported driver.
    default: throw kvErrorDiagnostics.KV_INVALID_DRIVER({ driver: JSON.stringify((store as { driver: unknown }).driver) })
  }
}

function createResolvedConfig(store: ResolvedKVModuleOptions["store"], stores?: Record<string, ResolvedKVModuleOptions["store"]>): ResolvedKVModuleOptions {
  return stores ? { store, stores: { default: store, ...stores } } : { store }
}

function hasStoresConfig(options: KVModuleOptions | undefined, stores: unknown): stores is KVStoresConfig["stores"] {
  // SAFETY: The own-property check establishes stores exists; its value stays unknown until isPlainObject validates it.
  return !!options && Object.hasOwn(options, "stores") && isPlainObject(stores)
}

export function normalizeKVOptions(
  options: KVModuleOptions | undefined,
  input: KVResolutionInput = {},
): ResolvedKVModuleOptions | undefined {
  if (options === false) return

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw kvErrorDiagnostics.KV_INVALID_CONFIG({ path: "kv" })
  }

  const env = input.env || process.env
  const hosting = normalizeHosting(input.hosting)
  const explicit = options as KVStoreConfig | InferredKVStoreConfig | undefined
  const hasOwnStores = options !== undefined && Object.hasOwn(options, "stores")
  // SAFETY: Reflect.get preserves the effective value exposed by a Proxy or accessor; ownness is checked separately above.
  const stores = hasOwnStores ? Reflect.get(options, "stores", options) : undefined
  if (hasOwnStores && !isPlainObject(stores)) {
    throw kvErrorDiagnostics.KV_INVALID_CONFIG({ path: "kv.stores" })
  }

  if (hasStoresConfig(options, stores)) {
    const resolvedStores = Object.fromEntries(
      Object.entries(stores).map(([name, store]) => [name, resolveExplicitStore(store, env, name, input.dev)]),
    )
    const defaultStore = resolvedStores.default
    if (!defaultStore) throw kvErrorDiagnostics.KV_MISSING_DEFAULT_STORE()
    return createResolvedConfig(defaultStore, resolvedStores)
  }

  if (explicit?.driver) return createResolvedConfig(resolveExplicitStore(explicit, env, "default", input.dev))
  const remote = explicit ? readRemote(explicit, "default") : undefined
  const inferred = (store: ResolvedKVStoreConfig) => createResolvedConfig(input.dev ? resolveDevStore(store, remote) : store)
  // Only an explicit `remote: true` lets `vite dev` infer a hosted store from env or the host.
  const hosted = !input.dev || remote === true
  if (hosting.includes("deno")) return inferred(resolveDenoStore())
  if (hosted && hasUpstashEnv(env)) return inferred(resolveUpstashStore())
  if (hosted && hosting.includes("vercel")) return inferred(resolveUpstashStore())
  if (hosting.includes("cloudflare")) return inferred(resolveCloudflareStore({}, env))
  if (input.dev && remote === true) throw kvErrorDiagnostics.KV_REMOTE_CONFLICT({ driver: "fs-lite", remote, store: "default" })
  return inferred(resolveFsLiteStore())
}

export function warnVercelKVFallback(
  target: { logger: { error: (message: string) => void } },
  config: ResolvedKVModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !normalizeHosting(hosting).includes("vercel")) return
  const stores = Object.values(config.stores || { default: config.store })
  if (!stores.some(store => store.driver === "fs-lite")) return
  target.logger.error(
    "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
  )
}
