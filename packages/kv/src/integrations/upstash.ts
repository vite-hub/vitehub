import { readEnv, trimmed } from "../internal/env.ts"

import type { ResolvedUpstashKVStoreConfig, UpstashKVStoreConfig } from "../types.ts"

export const maskedUpstashRuntimeValue = "********"

export function hasUpstashEnv(env: Record<string, string | undefined>): boolean {
  const url = readEnv(env, "KV_REST_API_URL")
  const token = readEnv(env, "KV_REST_API_TOKEN")
  return Boolean(url && token)
}

export function resolveUpstashStore(
  config: Partial<UpstashKVStoreConfig> = {},
): ResolvedUpstashKVStoreConfig {
  return {
    driver: "upstash",
    token: trimmed(config.token) ?? maskedUpstashRuntimeValue,
    url: trimmed(config.url) ?? maskedUpstashRuntimeValue,
  }
}
