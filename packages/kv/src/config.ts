import { defu } from "defu"
import { normalizeKey } from "unstorage"

import { readEnv, trimmed } from "@vite-hub/internal/env"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"
import { hasUpstashEnv, resolveUpstashStore } from "./integrations/upstash.ts"

import type {
  CloudflareKVStoreConfig,
  DatabaseKVStoreConfig,
  DenoKVStoreConfig,
  FsLiteKVStoreConfig,
  InferredKVStoreConfig,
  KVOptions,
  KVStoreConfig,
  KVStoresConfig,
  RedisKVStoreConfig,
  ResolvedCloudflareKVStoreConfig,
  ResolvedDatabaseKVStoreConfig,
  ResolvedDenoKVStoreConfig,
  ResolvedFsLiteKVStoreConfig,
  ResolvedKVModuleOptions,
  ResolvedKVStoreConfig,
  ResolvedRedisKVStoreConfig,
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
  /**
   * The app has a Default Database on Postgres. A build without a KV driver then infers the `database` driver on Node.
   * The KV Vite plugin finds it in the Database Definitions.
   */
  postgresDatabase?: boolean
}

/** The variable that a `redis` store reads at runtime when it sets no `url`. */
export const redisUrlEnvName = "REDIS_URL"

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

/**
 * The folder of an `fs-lite` store without `base`. The default store keeps `.vitehub/data/kv`. Each named store gets its
 * own folder next to it, so stores never share keys. It is not inside `.vitehub/data/kv`, because the default store
 * treats folders there as keys from the old layout.
 */
function fsLiteStoreBase(name: string): string {
  if (name === "default") return ".vitehub/data/kv"
  // Keep the name in one folder segment, also for `.` and `..`.
  return `.vitehub/data/kv-stores/${encodeURIComponent(name).replace(/\./g, "%2E") || "%"}`
}

function resolveFsLiteStore(config: Partial<FsLiteKVStoreConfig> = {}, name = "default"): ResolvedFsLiteKVStoreConfig {
  return defu({ base: trimmed(config.base) }, { driver: "fs-lite" as const, base: fsLiteStoreBase(name) })
}

/** The key prefix of a Redis store without `base`. Every store has one, so a shared Redis keeps other keys apart. */
export function redisStorePrefix(name: string): string {
  // Keep the name in one segment through unstorage's key normalization, including an empty name.
  const segment = name.replace(/[%:/\\?]/g, character => encodeURIComponent(character)) || "%"
  return `vitehub:kv:${segment}`
}

export function resolveRedisStore(config: Partial<RedisKVStoreConfig>, name: string): ResolvedRedisKVStoreConfig {
  // An empty prefix would let `kv.clear()` and `kv.keys()` reach every key of the Redis database.
  return {
    driver: "redis",
    base: normalizeKey(trimmed(config.base)) || redisStorePrefix(name),
    url: trimmed(config.url) ?? `env:${redisUrlEnvName}`,
  }
}

function resolveDatabaseStore(config: Partial<DatabaseKVStoreConfig>, name: string): ResolvedDatabaseKVStoreConfig {
  return { driver: "database", database: trimmed(config.database) ?? "default", namespace: name }
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
  if (dev && ((remote === true && (driver === "fs-lite" || driver === "deno-kv")) || (remote === false && driver === "upstash"))) {
    throw kvErrorDiagnostics.KV_REMOTE_CONFLICT({ driver, remote, store: name })
  }
  const resolved = resolveStoreDriver(store, env, name)
  return dev ? resolveDevStore(resolved, remote) : resolved
}

function resolveStoreDriver(store: KVStoreConfig, env: Record<string, string | undefined>, name: string): ResolvedKVStoreConfig {
  switch (store.driver) {
    case "cloudflare-kv-binding": return resolveCloudflareStore(store, env)
    case "database": return resolveDatabaseStore(store, name)
    case "deno-kv": return resolveDenoStore(store)
    case "fs-lite": return resolveFsLiteStore(store, name)
    case "redis": return resolveRedisStore(store, name)
    case "upstash": return resolveUpstashStore(store)
    // SAFETY: The invalid driver branch reads only the driver field for diagnostics, without using it as a supported driver.
    default: throw kvErrorDiagnostics.KV_INVALID_DRIVER({ driver: JSON.stringify((store as { driver: unknown }).driver) })
  }
}

function createResolvedConfig(store: ResolvedKVModuleOptions["store"], stores?: Record<string, ResolvedKVModuleOptions["store"]>): ResolvedKVModuleOptions {
  return stores ? { store, stores: { default: store, ...stores } } : { store }
}

function hasStoresConfig(options: KVOptions | undefined, stores: unknown): stores is KVStoresConfig["stores"] {
  // SAFETY: The own-property check establishes stores exists; its value stays unknown until isPlainObject validates it.
  return !!options && Object.hasOwn(options, "stores") && isPlainObject(stores)
}

export function normalizeKVOptions(
  options: KVOptions | undefined,
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
  if (hosting.includes("deno")) {
    if (input.dev && remote === true) throw kvErrorDiagnostics.KV_REMOTE_CONFLICT({ driver: "deno-kv", remote, store: "default" })
    return inferred(resolveDenoStore())
  }
  if (hosted && hasUpstashEnv(env)) return inferred(resolveUpstashStore())
  if (hosted && hosting.includes("vercel")) return inferred(resolveUpstashStore())
  if (hosting.includes("cloudflare")) return inferred(resolveCloudflareStore({}, env))
  if (input.dev && remote === true) throw kvErrorDiagnostics.KV_REMOTE_CONFLICT({ driver: "fs-lite", remote, store: "default" })
  if (input.dev) return inferred(resolveFsLiteStore())
  // Node and other servers keep the build-selected driver. Redis requires an explicit driver.
  if (input.postgresDatabase) return inferred({ ...resolveDatabaseStore({}, "default"), inferred: true })
  return inferred({ ...resolveFsLiteStore(), inferred: true })
}

/** The line that a server prints at boot for its build-selected inferred store. */
export function kvInferredStoreNotice(name: string, store: ResolvedKVStoreConfig): string | undefined {
  if (!("inferred" in store) || !store.inferred) return
  if (store.driver === "database") return `[vitehub] KV store "${name}" uses the table vitehub_kv of the Database "${store.database}", selected at build time.`
  if (store.driver === "fs-lite") return `[vitehub] KV store "${name}" uses fs-lite in ${store.base}, selected at build time. Other server processes cannot read its keys.`
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
