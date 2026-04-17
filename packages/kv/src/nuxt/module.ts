import { defineNuxtModule } from "@nuxt/kit"

import { pushUnique } from "../internal/arrays.ts"

import type { NitroConfig } from "nitro/types"
import type { KVModuleOptions } from "../types.ts"

type KVConfig = Exclude<KVModuleOptions, false>

export type KVNuxtModule = (
  resolvedOptions: KVConfig | undefined,
  nuxt: unknown,
) => void | Promise<void>

function applyNitroConfig(nitro: NitroConfig, config: KVConfig | undefined) {
  nitro.modules ||= []
  pushUnique(nitro.modules as string[], "@vitehub/kv/nitro")

  if (typeof config !== "undefined") {
    nitro.kv = config
  }
}

const kvNuxtModule: KVNuxtModule = defineNuxtModule<KVConfig>({
  meta: {
    configKey: "kv",
    name: "@vitehub/kv/nuxt",
  },
  setup(inlineOptions, nuxt) {
    const nuxtOptions = nuxt.options as typeof nuxt.options & { kv?: KVModuleOptions, nitro?: NitroConfig }
    const topLevelOptions = nuxtOptions.kv

    if (topLevelOptions === false) return

    const kvConfig = topLevelOptions ?? inlineOptions
    const nitro = (nuxtOptions.nitro ||= {})

    applyNitroConfig(nitro, kvConfig)
    ;(nuxt.hook as (name: string, fn: (nitroConfig: NitroConfig) => void) => void)(
      "nitro:config",
      nitroConfig => applyNitroConfig(nitroConfig, kvConfig),
    )
  },
}) as unknown as KVNuxtModule

export default kvNuxtModule
