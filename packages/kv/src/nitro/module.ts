import { resolveModulePath } from "exsolve"
import type { NitroModule, NitroRuntimeConfig } from "nitro/types"

import { normalizeKVOptions, warnVercelKVFallback } from "../config.ts"
import { configureCloudflareKV } from "../integrations/cloudflare.ts"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "../types.ts"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  const fromSource = resolveModulePath(srcRelative, {
    from: import.meta.url,
    extensions: [".ts", ".mts"],
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    from: import.meta.url,
    extensions: [".js", ".mjs"],
  })
}

const kvNitroModule: NitroModule = {
  name: "@vitehub/kv",
  setup(nitro) {
    const hosting = (nitro.options.preset || process.env.NITRO_PRESET || "").trim() || undefined
    const resolved = normalizeKVOptions(nitro.options.kv, { env: process.env, hosting })

    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (hosting) {
      runtimeConfig.hosting ||= hosting
    }
    runtimeConfig.kv = resolved ?? false

    if (!resolved) {
      return
    }

    const framework = (nitro.options as { framework?: { name?: string } }).framework?.name
    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/kv"] = framework === "nuxt"
      ? resolveRuntimeEntry("../runtime/nitropack-storage", "@vitehub/kv/runtime/nitropack-storage")
      : resolveRuntimeEntry("../index", "@vitehub/kv")
    if (framework === "nuxt") {
      nitro.options.alias["nitro/runtime-config"] = "nitropack/runtime/config"
      nitro.options.alias["nitro/storage"] = "nitropack/runtime/storage"
    }

    if (resolved.store.driver === "upstash") {
      nitro.options.plugins ||= []
      const plugin = framework === "nuxt"
        ? resolveRuntimeEntry("../runtime/nitropack-plugin", "@vitehub/kv/runtime/nitropack-plugin")
        : resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/kv/runtime/nitro-plugin")
      if (!nitro.options.plugins.includes(plugin)) {
        nitro.options.plugins.push(plugin)
      }
    }

    nitro.options.storage ||= {}
    nitro.options.storage.kv = resolved.store

    configureCloudflareKV(nitro.options, resolved)
    warnVercelKVFallback(nitro, resolved, hosting)
  },
}

export default kvNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    cloudflare?: { wrangler?: { kv_namespaces?: { binding: string, id: string }[] } }
    kv?: KVModuleOptions
  }

  interface NitroConfig {
    kv?: KVModuleOptions
  }

  interface NitroRuntimeConfig {
    hosting?: string
    kv?: false | ResolvedKVModuleOptions
  }
}
