import { readEnv } from "./internal/env.ts"
import { trimmed } from "./internal/strings.ts"
import { hasUpstashEnv, resolveUpstashStore } from "./integrations/upstash.ts"

import type {
  CloudflareKVStoreConfig,
  FsLiteKVStoreConfig,
  KVModuleOptions,
  KVStoreConfig,
  ResolvedCloudflareKVStoreConfig,
  ResolvedFsLiteKVStoreConfig,
  ResolvedKVModuleOptions,
  UpstashKVStoreConfig,
} from "./types.ts"

export interface KVResolutionInput {
  env?: Record<string, string | undefined>
  hosting?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function resolveFsLiteStore(
  config: Partial<FsLiteKVStoreConfig> = {},
): ResolvedFsLiteKVStoreConfig {
  return {
    driver: "fs-lite",
    base: trimmed(config.base) ?? ".data/kv",
  }
}

function resolveCloudflareStore(
  config: Partial<CloudflareKVStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareKVStoreConfig {
  return {
    driver: "cloudflare-kv-binding",
    binding: trimmed(config.binding) ?? "KV",
    namespaceId: trimmed(config.namespaceId) ?? readEnv(env, "KV_NAMESPACE_ID"),
  }
}

const storeResolvers = {
  "cloudflare-kv-binding": (store: KVStoreConfig, env: Record<string, string | undefined>) =>
    resolveCloudflareStore(store as CloudflareKVStoreConfig, env),
  "upstash": (store: KVStoreConfig) => resolveUpstashStore(store as UpstashKVStoreConfig),
  "fs-lite": (store: KVStoreConfig) => resolveFsLiteStore(store as FsLiteKVStoreConfig),
} as const

function resolveExplicitStore(store: KVStoreConfig, env: Record<string, string | undefined>) {
  return storeResolvers[store.driver](store, env)
}

function isCloudflareHosting(hosting: string | undefined) {
  return Boolean(hosting?.includes("cloudflare"))
}

function isVercelHosting(hosting: string | undefined) {
  return Boolean(hosting?.includes("vercel"))
}

export function normalizeKVOptions(
  options: KVModuleOptions | undefined,
  input: KVResolutionInput = {},
): ResolvedKVModuleOptions | undefined {
  if (options === false) return undefined

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`kv` must be a plain object.")
  }

  const env = input.env || process.env
  const hosting = input.hosting || ""
  const explicitStore = options as KVStoreConfig | undefined

  if (explicitStore?.driver) {
    return { store: resolveExplicitStore(explicitStore, env) }
  }

  if (hasUpstashEnv(env)) {
    return { store: resolveUpstashStore() }
  }

  if (isCloudflareHosting(hosting)) {
    return { store: resolveCloudflareStore({}, env) }
  }

  return { store: resolveFsLiteStore() }
}

export function warnVercelKVFallback(
  target: { logger?: { error?: (message: string) => void } },
  config: ResolvedKVModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !isVercelHosting(hosting) || config.store.driver !== "fs-lite") return

  target.logger?.error?.(
    "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
  )
}
