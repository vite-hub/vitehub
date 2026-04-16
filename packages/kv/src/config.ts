import { readEnv } from "./internal/env.ts"
import { hasUpstashEnv, resolveUpstashStore } from "./integrations/upstash.ts"

import type {
  CloudflareKVStoreConfig,
  FsLiteKVStoreConfig,
  KVModuleOptions,
  KVStoreConfig,
  ResolvedCloudflareKVStoreConfig,
  ResolvedFsLiteKVStoreConfig,
  ResolvedKVModuleOptions,
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
    base: typeof config.base === "string" && config.base.trim()
      ? config.base.trim()
      : ".data/kv",
  }
}

function resolveCloudflareStore(
  config: Partial<CloudflareKVStoreConfig> = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedCloudflareKVStoreConfig {
  return {
    driver: "cloudflare-kv-binding",
    binding: typeof config.binding === "string" && config.binding.trim()
      ? config.binding.trim()
      : "KV",
    namespaceId: typeof config.namespaceId === "string" && config.namespaceId.trim()
      ? config.namespaceId.trim()
      : readEnv(env, "KV_NAMESPACE_ID"),
  }
}

function resolveExplicitStore(
  store: KVStoreConfig,
  env: Record<string, string | undefined>,
) {
  switch (store.driver) {
    case "cloudflare-kv-binding":
      return resolveCloudflareStore(store, env)
    case "upstash":
      return resolveUpstashStore(store)
    case "fs-lite":
      return resolveFsLiteStore(store)
  }
}

function isCloudflareHosting(hosting: string | undefined) {
  return Boolean(hosting && hosting.includes("cloudflare"))
}

function isVercelHosting(hosting: string | undefined) {
  return Boolean(hosting && hosting.includes("vercel"))
}

export function normalizeKVOptions(
  options: KVModuleOptions | undefined,
  input: KVResolutionInput = {},
): ResolvedKVModuleOptions | undefined {
  if (options === false) {
    return undefined
  }

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`kv` must be a plain object.")
  }

  const env = input.env || process.env
  const hosting = input.hosting || ""
  const explicitStore = options as KVStoreConfig | undefined

  if (explicitStore?.driver) {
    return {
      store: resolveExplicitStore(explicitStore, env),
    }
  }

  if (hasUpstashEnv(env)) {
    return {
      store: resolveUpstashStore(),
    }
  }

  if (isCloudflareHosting(hosting)) {
    return {
      store: resolveCloudflareStore({}, env),
    }
  }

  return {
    store: resolveFsLiteStore(),
  }
}

export function warnVercelKVFallback(
  target: { logger?: { error?: (message: string) => void } },
  config: ResolvedKVModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !isVercelHosting(hosting) || config.store.driver !== "fs-lite") {
    return
  }

  target.logger?.error?.(
    "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
  )
}
