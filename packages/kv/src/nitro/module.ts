import { normalizeKVOptions, warnVercelKVFallback } from "../config.ts"
import { pushUnique } from "../internal/arrays.ts"
import { resolveRuntimePath } from "../internal/resolve-runtime-path.ts"
import { configureCloudflareKV } from "../integrations/cloudflare.ts"

import type { NitroModule } from "nitro/types"
import type { KVModuleOptions, ResolvedKVModuleOptions } from "../types.ts"

const kvNitroModule: NitroModule = {
  name: "@vitehub/kv",
  setup(nitro) {
    const options = nitro.options
    const hosting = (options.preset || process.env.NITRO_PRESET || "").trim() || undefined
    const resolved = normalizeKVOptions(options.kv, { env: process.env, hosting })

    const runtimeConfig = (options.runtimeConfig ||= {} as typeof options.runtimeConfig)
    if (hosting) runtimeConfig.hosting ||= hosting
    runtimeConfig.kv = resolved ?? false

    if (!resolved) return

    options.alias ||= {}
    options.alias["@vitehub/kv"] = resolveRuntimePath(import.meta.url, "../index.ts", "@vitehub/kv")

    options.plugins ||= []
    pushUnique(
      options.plugins,
      resolveRuntimePath(import.meta.url, "../runtime/nitro-plugin.ts", "@vitehub/kv/runtime/nitro-plugin"),
    )

    if (options.imports !== false) {
      const imports = (options.imports ||= {} as Exclude<typeof options.imports, false>)
      imports.presets ||= []
      pushUnique(
        imports.presets,
        { from: "@vitehub/kv", imports: ["kv"] },
        preset => typeof preset === "object" && preset && "from" in preset ? preset.from : preset,
      )
    }

    options.storage ||= {} as typeof options.storage
    options.storage.kv = resolved.store

    configureCloudflareKV(options, resolved)
    warnVercelKVFallback(nitro, resolved, hosting)
  },
}

export default kvNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    kv?: KVModuleOptions
    cloudflare?: {
      wrangler?: {
        kv_namespaces?: Array<{ binding: string, id: string }>
      }
    }
  }

  interface NitroRuntimeConfig {
    hosting?: string
    kv?: false | ResolvedKVModuleOptions
  }
}
