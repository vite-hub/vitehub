import type { NitroModule } from "nitro/types"

import { normalizeKVOptions, warnVercelKVFallback } from "../config.ts"
import { configureCloudflareKV } from "../integrations/cloudflare.ts"
import { resolveRuntimePath } from "../internal/resolve-runtime-path.ts"

import type {
  KVModuleOptions,
  ResolvedKVModuleOptions,
  ResolvedKVStoreConfig,
} from "../types.ts"

interface NitroRuntimeConfigLike {
  hosting?: string
  kv?: false | ResolvedKVModuleOptions
}

interface NitroOptionsLike {
  alias?: Record<string, string>
  kv?: KVModuleOptions
  plugins?: string[]
  preset?: string | null
  runtimeConfig?: NitroRuntimeConfigLike
  storage?: Record<string, unknown> & {
    kv?: ResolvedKVStoreConfig
  }
  cloudflare?: {
    wrangler?: {
      kv_namespaces?: Array<{
        binding: string
        id: string
      }>
    }
  }
}

const kvNitroModule: NitroModule = {
  name: "@vitehub/kv",
  setup(nitro) {
    const options = nitro.options as NitroOptionsLike
    const hosting = (options.preset || process.env.NITRO_PRESET || "").trim() || undefined
    const resolved = normalizeKVOptions(options.kv, {
      env: process.env,
      hosting,
    })

    const runtimeConfig = (options.runtimeConfig ||= {})
    if (hosting) {
      runtimeConfig.hosting ||= hosting
    }
    runtimeConfig.kv = resolved ?? false

    if (!resolved) {
      return
    }

    options.alias ||= {}
    options.alias["@vitehub/kv"] = resolveRuntimePath(import.meta.url, "../index.ts", "./index.js")

    options.plugins ||= []
    const nitroPlugin = resolveRuntimePath(import.meta.url, "../runtime/nitro-plugin.ts", "./runtime/nitro-plugin.js")
    if (!options.plugins.includes(nitroPlugin)) {
      options.plugins.push(nitroPlugin)
    }

    const storage = (options.storage ||= {})
    storage.kv = resolved.store

    configureCloudflareKV(options, resolved)
    warnVercelKVFallback(nitro, resolved, hosting)
  },
}

export default kvNitroModule

declare module "nitro/types" {
  interface NitroConfig {
    kv?: KVModuleOptions
  }

  interface NitroRuntimeConfig {
    hosting?: string
    kv?: false | ResolvedKVModuleOptions
  }
}
