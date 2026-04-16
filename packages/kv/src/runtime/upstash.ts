import { readEnv } from "../internal/env.ts"

import type {
  ResolvedKVModuleOptions,
  ResolvedUpstashKVStoreConfig,
} from "../types.ts"

function isMaskedValue(value: string | undefined) {
  if (!value) {
    return true
  }

  return /^\*+$/.test(value) || value.includes("********")
}

function assertRuntimeValue(value: string | undefined, envName: string) {
  if (isMaskedValue(value)) {
    throw new Error(`Missing runtime environment variable \`${envName}\` for Upstash KV.`)
  }
}

function resolveRuntimeUpstashStore(
  config: ResolvedUpstashKVStoreConfig,
  env: Record<string, string | undefined>,
): ResolvedUpstashKVStoreConfig {
  const envUrl = readEnv(env, "KV_REST_API_URL", "UPSTASH_REDIS_REST_URL")
  const envToken = readEnv(
    env,
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_TOKEN",
  )

  const resolved = {
    ...config,
    token: isMaskedValue(config.token) ? envToken || config.token : config.token,
    url: isMaskedValue(config.url) ? envUrl || config.url : config.url,
  }

  assertRuntimeValue(resolved.url, "KV_REST_API_URL")
  assertRuntimeValue(resolved.token, "KV_REST_API_TOKEN")

  return resolved
}

export function resolveRuntimeKVOptions(
  config: false | ResolvedKVModuleOptions | undefined,
  env: Record<string, string | undefined> = process.env,
): false | ResolvedKVModuleOptions | undefined {
  if (!config || config.store.driver !== "upstash") {
    return config
  }

  return {
    ...config,
    store: resolveRuntimeUpstashStore(config.store, env),
  } satisfies ResolvedKVModuleOptions
}
