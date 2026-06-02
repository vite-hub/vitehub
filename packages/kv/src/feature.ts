import { createFeatureEngine, normalizeFeaturePublicOptions, readFeaturePublicOptions } from "@vite-hub/internal/feature-bridge"
import { resolveRuntimeEntry as resolveEntry } from "@vite-hub/internal/nitro"

import { warnVercelKVFallback } from "./config.ts"
import { configureCloudflareKV } from "./integrations/cloudflare.ts"
import { resolveKVViteConfig } from "./vite-config.ts"

import type { FeatureStateSource } from "@vite-hub/internal/feature-bridge"
import type { FeatureNitroLike } from "@vite-hub/internal/feature-bridge"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "./types.ts"

type KVNitroOptions = FeatureNitroLike["options"] & {
  alias?: Record<string, string>
  cloudflare?: { wrangler?: { kv_namespaces?: { binding: string, id: string }[] } }
  plugins?: string[]
  storage?: Record<string, unknown>
}

type KVNitroTarget = FeatureNitroLike & {
  logger: {
    error: (message: string) => void
  }
  options: KVNitroOptions
}

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function normalizeKVPublicOptions(options: KVModuleOptions | false | undefined): KVModuleOptions | undefined {
  return normalizeFeaturePublicOptions("kv", options)
}

function readKVPublicOptions(source: FeatureStateSource<KVModuleOptions>): KVModuleOptions | undefined {
  const options = readFeaturePublicOptions<KVModuleOptions>(source, "kv")
  return typeof options === "undefined" ? ({} as KVModuleOptions) : options
}

export const kvFeatureEngine = createFeatureEngine<KVModuleOptions, KVModuleOptions, false | ResolvedKVModuleOptions>({
  name: "@vite-hub/kv",
  feature: "kv",
  configKey: "kv",
  normalizeOptions: normalizeKVPublicOptions,
  resolveConfig(options, hosting) {
    return resolveKVViteConfig(options, {
      env: process.env,
      hosting,
    }).kv
  },
  readPublicOptions: readKVPublicOptions,
  setupNitro(nitro: FeatureNitroLike, context) {
    if (!context.config)
      return

    const target = nitro as KVNitroTarget
    const resolved = context.config

    target.options.alias ||= {}
    target.options.alias["@vite-hub/kv"] = resolveRuntimeEntry("./index", "@vite-hub/kv")

    target.options.plugins ||= []
    const plugin = resolveRuntimeEntry("./runtime/nitro-plugin", "@vite-hub/kv/internal/runtime/nitro-plugin")
    if (!target.options.plugins.includes(plugin))
      target.options.plugins.push(plugin)

    target.options.storage ||= {}
    target.options.storage.kv = resolved.store

    configureCloudflareKV(target.options, resolved)
    warnVercelKVFallback(target, resolved, context.hosting)
  },
})
