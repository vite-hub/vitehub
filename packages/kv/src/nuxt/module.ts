import { defineNuxtModule } from "@nuxt/kit"
import type { NitroConfig } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

import type { KVModuleOptions, KVStoreConfig } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/kv/nitro"

function installKVNitroModule(nitro: NitroConfig, kv: KVModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) {
    nitro.modules.push(NITRO_MODULE_ID)
  }
  if (kv !== undefined) {
    nitro.kv = kv
  }
}

const kvNuxtModule: NuxtModule<KVStoreConfig, KVStoreConfig, false> = defineNuxtModule<KVStoreConfig>({
  meta: { configKey: "kv", name: "@vitehub/kv/nuxt" },
  setup(inlineOptions, nuxt) {
    const topLevel = nuxt.options.kv
    if (topLevel === false) {
      return
    }

    const kv = topLevel ?? inlineOptions
    nuxt.options.nitro ||= {}
    installKVNitroModule(nuxt.options.nitro, kv)
    nuxt.hook("nitro:config", config => installKVNitroModule(config, kv))
  },
})

export default kvNuxtModule

declare module "@nuxt/schema" {
  interface NuxtConfig {
    kv?: KVModuleOptions
    nitro?: NitroConfig
  }
  interface NuxtOptions {
    kv?: KVModuleOptions
    nitro?: NitroConfig
  }
  interface NuxtHooks {
    "nitro:config": (config: NitroConfig) => void | Promise<void>
  }
}
