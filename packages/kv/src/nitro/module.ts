import { resolveModulePath } from "exsolve"
import type { NitroModule } from "nitro/types"

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

    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as never)
    if (hosting) {
      runtimeConfig.hosting ||= hosting
    }
    runtimeConfig.kv = resolved ?? false

    if (!resolved) {
      return
    }

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/kv"] = resolveRuntimeEntry("../index", "@vitehub/kv")

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/kv/runtime/nitro-plugin")
    if (!nitro.options.plugins.includes(plugin)) {
      nitro.options.plugins.push(plugin)
    }

    nitro.options.storage ||= {}
    nitro.options.storage.kv = resolved.store as never

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
