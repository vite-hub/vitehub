import { normalizeKVOptions } from "./config.ts"
import { readEnv, trimmed } from "./internal/env.ts"

import type { KVResolutionInput } from "./config.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "./types.ts"

export const KV_VITE_PLUGIN_NAME = "@vitehub/kv/vite"
export const KV_VIRTUAL_CONFIG_ID = "virtual:@vitehub/kv/config"

export interface KVViteRuntimeConfig {
  hosting?: string
  kv: false | ResolvedKVModuleOptions
}

function resolveHosting(input: KVResolutionInput): string | undefined {
  const env = input.env || process.env
  return trimmed(input.hosting) ?? readEnv(env, "NITRO_PRESET", "VITEHUB_HOSTING")
}

export function resolveKVViteConfig(
  kv: KVModuleOptions | undefined,
  input: KVResolutionInput = {},
): KVViteRuntimeConfig {
  const env = input.env || process.env
  const hosting = resolveHosting(input)
  const resolved = normalizeKVOptions(kv, { env, hosting })
  return { hosting, kv: resolved ?? false }
}
