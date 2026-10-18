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
import { kvErrorDiagnostics } from "./error-diagnostics.ts"

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

function resolveExplicitStore(store: KVStoreConfig, env: Record<string, string | undefined>) {
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
  const explicit = options as KVStoreConfig | undefined
  const hasOwnStores = options !== undefined && Object.hasOwn(options, "stores")
  // SAFETY: Reflect.get preserves the effective value exposed by a Proxy or accessor; ownness is checked separately above.
  const stores = hasOwnStores ? Reflect.get(options, "stores", options) : undefined
  if (hasOwnStores && !isPlainObject(stores)) {
    throw kvErrorDiagnostics.KV_INVALID_CONFIG({ path: "kv.stores" })
  }

  if (hasStoresConfig(options, stores)) {
    const resolvedStores = Object.fromEntries(
      Object.entries(stores).map(([name, store]) => [name, resolveExplicitStore(store, env)]),
    )
    const defaultStore = resolvedStores.default
    if (!defaultStore) throw kvErrorDiagnostics.KV_MISSING_DEFAULT_STORE()
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
