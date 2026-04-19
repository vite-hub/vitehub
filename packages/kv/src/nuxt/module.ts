import { defineNuxtModule } from "@nuxt/kit"
import type { NitroConfig } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

import type { KVModuleOptions, KVStoreConfig } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/kv/nitro"

function installKVNitroModule(nitro: Record<string, any>, kv: KVModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) {
    nitro.modules.push(NITRO_MODULE_ID)
  }
  if (kv !== undefined) {
    nitro.kv = kv
  }
}

const kvNuxtModule: NuxtModule<KVStoreConfig> = defineNuxtModule<any>({
  meta: { configKey: "kv", name: "@vitehub/kv/nuxt" },
  setup(inlineOptions, nuxt) {
    const nuxtOptions = nuxt.options as Record<string, any>
    const topLevel = nuxtOptions.kv as KVStoreConfig | false | undefined
    if (topLevel === false) {
      return
    }

    const kv = topLevel ?? inlineOptions as KVStoreConfig | undefined
    const nitro = nuxtOptions.nitro ||= {}
    installKVNitroModule(nitro, kv)
    ;(nuxt.hook as any)("nitro:config", (config: Record<string, any>) => installKVNitroModule(config, kv))
  },
}) as unknown as NuxtModule<KVStoreConfig>

export default kvNuxtModule

declare module "@nuxt/schema" {
  interface NuxtConfig {
    kv?: KVModuleOptions | false
    nitro?: NitroConfig
  }
  interface NuxtOptions {
    kv?: KVModuleOptions | false
    nitro?: NitroConfig
  }
  interface NuxtHooks {
    "nitro:config": (config: NitroConfig) => void | Promise<void>
  }
}
