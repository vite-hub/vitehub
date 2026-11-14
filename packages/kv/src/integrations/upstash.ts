import { readEnv, trimmed } from "@vite-hub/internal/env"

import type { ResolvedUpstashKVStoreConfig, UpstashKVStoreConfig } from "../types.ts"

const maskedUpstashRuntimeValue = "********"

/** Vercel names first, then the names that the Upstash console and NuxtHub use. */
export const upstashUrlEnvNames = ["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL"] as const
export const upstashTokenEnvNames = ["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN"] as const

export function hasUpstashEnv(env: Record<string, string | undefined>): boolean {
  const url = readEnv(env, ...upstashUrlEnvNames)
  const token = readEnv(env, ...upstashTokenEnvNames)
  return Boolean(url && token)
}

/** `base` is the resolved key prefix of the store, never empty. */
export function resolveUpstashStore(
  config: Partial<UpstashKVStoreConfig>,
  base: string,
): ResolvedUpstashKVStoreConfig {
  return {
    driver: "upstash",
    base,
    token: trimmed(config.token) ?? maskedUpstashRuntimeValue,
    url: trimmed(config.url) ?? maskedUpstashRuntimeValue,
  }
}
