import { readEnv } from "../internal/env.ts"

import type { ResolvedUpstashKVStoreConfig, UpstashKVStoreConfig } from "../types.ts"

export const maskedUpstashRuntimeValue = "********"

export function hasUpstashEnv(env: Record<string, string | undefined>): boolean {
  const url = readEnv(env, "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL")
  const token = readEnv(env, "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN")
  return Boolean(url && token)
}

export function resolveUpstashStore(
  config: Partial<UpstashKVStoreConfig> = {},
): ResolvedUpstashKVStoreConfig {
  const explicitToken = typeof config.token === "string" && config.token.trim()
    ? config.token.trim()
    : undefined
  const explicitUrl = typeof config.url === "string" && config.url.trim()
    ? config.url.trim()
    : undefined

  return {
    driver: "upstash",
    token: explicitToken || maskedUpstashRuntimeValue,
    url: explicitUrl || maskedUpstashRuntimeValue,
  }
}
