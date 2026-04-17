import { normalizeKVOptions } from "./config.ts"
import { readEnv, trimmed } from "./internal/env.ts"

import type { KVResolutionInput } from "./config.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "./types.ts"
import type { Plugin } from "vite"

export const KV_VITE_PLUGIN_NAME = "@vitehub/kv/vite"
export const KV_VIRTUAL_CONFIG_ID = "virtual:@vitehub/kv/config"
const RESOLVED_KV_VIRTUAL_CONFIG_ID = `\0${KV_VIRTUAL_CONFIG_ID}`

export interface KVViteRuntimeConfig {
  hosting?: string
  kv: false | ResolvedKVModuleOptions
}

export interface KVVitePluginAPI {
  getConfig: () => KVViteRuntimeConfig
}

export type KVVitePlugin = Plugin & { api: KVVitePluginAPI }

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

function serializeVirtualConfig(config: KVViteRuntimeConfig): string {
  return [
    `export const hosting = ${JSON.stringify(config.hosting)};`,
    `export const kv = ${JSON.stringify(config.kv)};`,
    "export default { hosting, kv };",
  ].join("\n")
}

export function hubKv(options?: KVModuleOptions): KVVitePlugin {
  let runtimeConfig: KVViteRuntimeConfig | undefined
  const getConfig = () => runtimeConfig ??= resolveKVViteConfig(options)

  return {
    name: KV_VITE_PLUGIN_NAME,
    api: { getConfig },
    configResolved(config) {
      runtimeConfig = resolveKVViteConfig(config.kv ?? options)
    },
    resolveId(id) {
      if (id === KV_VIRTUAL_CONFIG_ID) return RESOLVED_KV_VIRTUAL_CONFIG_ID
    },
    load(id) {
      if (id === RESOLVED_KV_VIRTUAL_CONFIG_ID) return serializeVirtualConfig(getConfig())
    },
  }
}

declare module "vite" {
  interface UserConfig {
    kv?: KVModuleOptions
  }
}
