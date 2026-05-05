import { defineNuxtModule } from "@nuxt/kit"
import { assertNoNitroModule, assertNoVitePlugin } from "@vitehub/internal/nitro"
import type { NitroConfig } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

import type { KVModuleOptions, KVStoreConfig } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/kv/nitro"
const NITRO_MODULE_NAME = "@vitehub/kv"
const NUXT_MODULE_ID = "@vitehub/kv/nuxt"
const VITE_PLUGIN_NAME = "@vitehub/kv/vite"
const installedNitroConfigs = new WeakSet<object>()

type ViteConfig = {
  plugins?: unknown
}

function installKVNitroModule(nitro: NitroConfig, kv: KVModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) {
    nitro.modules.push(NITRO_MODULE_ID)
  }
  if (kv !== undefined) {
    nitro.kv = kv
  }
  installedNitroConfigs.add(nitro)
}

const kvNuxtModule: NuxtModule<KVStoreConfig, KVStoreConfig, false> = defineNuxtModule<KVStoreConfig>({
  meta: { configKey: "kv", name: NUXT_MODULE_ID },
  async setup(inlineOptions, nuxt) {
    const topLevel = nuxt.options.kv
    if (topLevel === false) {
      return
    }

    const kv = topLevel ?? inlineOptions
    nuxt.options.nitro ||= {}
    await assertNoVitePlugin(nuxt.options.vite as ViteConfig | undefined, VITE_PLUGIN_NAME, NUXT_MODULE_ID)
    if (!installedNitroConfigs.has(nuxt.options.nitro)) {
      assertNoNitroModule(nuxt.options.nitro, NITRO_MODULE_ID, NITRO_MODULE_NAME, NUXT_MODULE_ID)
    }
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
