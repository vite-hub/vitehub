import { defu } from "defu"

import { readEnv, trimmed } from "@vite-hub/internal/env"
import { normalizeHosting } from "@vite-hub/internal/hosting"
import { isPlainObject } from "@vite-hub/internal/object"
import { hasUpstashEnv, resolveUpstashStore } from "./integrations/upstash.ts"

import type {
  CloudflareKVStoreConfig,
  DenoKVStoreConfig,
  FsLiteKVStoreConfig,
  KVModuleOptions,
  KVStoreConfig,
  KVStoresConfig,
  ResolvedCloudflareKVStoreConfig,
  ResolvedDenoKVStoreConfig,
  ResolvedFsLiteKVStoreConfig,
  ResolvedKVModuleOptions,
} from "./types.ts"

export interface KVResolutionInput {
  env?: Record<string, string | undefined>
  hosting?: string
}

function resolveFsLiteStore(config: Partial<FsLiteKVStoreConfig> = {}): ResolvedFsLiteKVStoreConfig {
  return defu({ base: trimmed(config.base) }, { driver: "fs-lite" as const, base: ".vitehub/data/kv" })
}

function resolveCloudflareStore(
  config: Partial<CloudflareKVStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareKVStoreConfig {
  return defu(
    { binding: trimmed(config.binding), namespaceId: trimmed(config.namespaceId) ?? readEnv(env, "KV_NAMESPACE_ID") },
    { driver: "cloudflare-kv-binding" as const, binding: "KV" },
  )
}

function resolveDenoStore(config: Partial<DenoKVStoreConfig> = {}): ResolvedDenoKVStoreConfig {
  const path = trimmed(config.path)
  return path ? { driver: "deno-kv", path } : { driver: "deno-kv" }
}

function resolveExplicitStore(store: KVStoreConfig, env: Record<string, string | undefined>) {
  switch (store.driver) {
    case "cloudflare-kv-binding": return resolveCloudflareStore(store, env)
    case "deno-kv": return resolveDenoStore(store)
    case "upstash": return resolveUpstashStore(store)
    case "fs-lite": return resolveFsLiteStore(store)
    default: throw new TypeError(`Unknown \`kv.driver\`: ${JSON.stringify((store as { driver: unknown }).driver)}. Expected "cloudflare-kv-binding", "deno-kv", "upstash", or "fs-lite".`)
  }
}

function createResolvedConfig(store: ResolvedKVModuleOptions["store"], stores?: Record<string, ResolvedKVModuleOptions["store"]>): ResolvedKVModuleOptions {
  return stores ? { store, stores: { default: store, ...stores } } : { store }
}

function hasStoresConfig(options: KVModuleOptions | undefined): options is KVStoresConfig {
  return !!options && "stores" in options && isPlainObject((options as { stores?: unknown }).stores)
}

export function normalizeKVOptions(
  options: KVModuleOptions | undefined,
  input: KVResolutionInput = {},
): ResolvedKVModuleOptions | undefined {
  if (options === false) return

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`kv` must be a plain object.")
  }

  const env = input.env || process.env
  const hosting = normalizeHosting(input.hosting)
  const explicit = options as KVStoreConfig | undefined

  if (hasStoresConfig(options)) {
    const resolvedStores = Object.fromEntries(
      Object.entries(options.stores).map(([name, store]) => [name, resolveExplicitStore(store, env)]),
    )
    const defaultStore = resolvedStores.default
    if (!defaultStore) throw new TypeError("`kv.stores.default` is required when using named KV stores.")
    return createResolvedConfig(defaultStore, resolvedStores)
  }

  if (explicit?.driver) return createResolvedConfig(resolveExplicitStore(explicit, env))
  if (hosting.includes("deno")) return createResolvedConfig(resolveDenoStore())
  if (hasUpstashEnv(env)) return createResolvedConfig(resolveUpstashStore())
  if (hosting.includes("vercel")) return createResolvedConfig(resolveUpstashStore())
  if (hosting.includes("cloudflare")) return createResolvedConfig(resolveCloudflareStore({}, env))
  return createResolvedConfig(resolveFsLiteStore())
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
