import { resolveModulePath } from "exsolve"
import type { NitroModule, NitroRuntimeConfig } from "nitro/types"

import { warnVercelKVFallback } from "../config.ts"
import { configureCloudflareKV } from "../integrations/cloudflare.ts"
import { resolveKVViteConfig } from "../vite-config.ts"
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
    const viteConfig = resolveKVViteConfig(nitro.options.kv, {
      env: process.env,
      hosting: nitro.options.preset,
    })
    const { hosting } = viteConfig

    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (hosting) runtimeConfig.hosting ||= hosting
    runtimeConfig.kv = viteConfig.kv

    if (!viteConfig.kv) return
    const resolved = viteConfig.kv

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/kv"] = resolveRuntimeEntry("../index", "@vitehub/kv")

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/kv/runtime/nitro-plugin")
    if (!nitro.options.plugins.includes(plugin)) {
      nitro.options.plugins.push(plugin)
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
