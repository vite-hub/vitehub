import { defu } from "defu"

import { readEnv, trimmed } from "./internal/env.ts"
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

function resolveFsLiteStore(config: Partial<FsLiteKVStoreConfig> = {}): ResolvedFsLiteKVStoreConfig {
  return defu({ base: trimmed(config.base) }, { driver: "fs-lite" as const, base: ".data/kv" })
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

function resolveExplicitStore(store: KVStoreConfig, env: Record<string, string | undefined>) {
  switch (store.driver) {
    case "cloudflare-kv-binding": return resolveCloudflareStore(store, env)
    case "upstash": return resolveUpstashStore(store)
    case "fs-lite": return resolveFsLiteStore(store)
    default: throw new TypeError(`Unknown \`kv.driver\`: ${JSON.stringify((store as { driver: unknown }).driver)}. Expected "cloudflare-kv-binding", "upstash", or "fs-lite".`)
  }
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
  const hosting = input.hosting || ""
  const explicit = options as KVStoreConfig | undefined

  if (explicit?.driver) return { store: resolveExplicitStore(explicit, env) }
  if (hasUpstashEnv(env)) return { store: resolveUpstashStore() }
  if (hosting.includes("vercel")) return { store: resolveUpstashStore() }
  if (hosting.includes("cloudflare")) return { store: resolveCloudflareStore({}, env) }
  return { store: resolveFsLiteStore() }
}

export function warnVercelKVFallback(
  target: { logger?: { error?: (message: string) => void } },
  config: ResolvedKVModuleOptions | undefined,
  hosting?: string,
): void {
  if (!config || !hosting?.includes("vercel") || config.store.driver !== "fs-lite") return
  target.logger?.error?.(
    "Vercel hosting requires Upstash-backed KV. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.",
  )
}
