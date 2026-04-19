import { defineNuxtModule } from "@nuxt/kit"
import type { NitroConfig } from "nitro/types"

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

const kvNuxtModule: ReturnType<typeof defineNuxtModule<KVStoreConfig>> = defineNuxtModule<KVStoreConfig>({
  meta: { configKey: "kv", name: "@vitehub/kv/nuxt" },
  setup(inlineOptions: KVStoreConfig, nuxt: { options: Record<string, any>; hook: (...args: any[]) => unknown }) {
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
})

export default kvNuxtModule
