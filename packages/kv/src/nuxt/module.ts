import { defineNuxtModule } from "@nuxt/kit"

import type { KVModuleOptions } from "../types.ts"

interface NitroOptionsLike {
  imports?: boolean
  kv?: Exclude<KVModuleOptions, false>
  modules?: string[]
}

interface NuxtLike {
  hook(
    name: "nitro:config",
    fn: (nitroConfig: NitroOptionsLike) => void | Promise<void>,
  ): void
  options: {
    kv?: KVModuleOptions
    nitro?: NitroOptionsLike
  }
}

type KVNuxtModule = {
  bivarianceHack(
    resolvedOptions: Exclude<KVModuleOptions, false> | undefined,
    nuxt: unknown,
  ): void | Promise<void>
}["bivarianceHack"]

function applyNitroConfig(
  nitro: NitroOptionsLike,
  config: Exclude<KVModuleOptions, false> | undefined,
) {
  nitro.modules ||= []

  if (!nitro.modules.includes("@vitehub/kv/nitro")) {
    nitro.modules.push("@vitehub/kv/nitro")
  }

  if (typeof config !== "undefined") {
    nitro.kv = config
  }
}

const kvNuxtModule: KVNuxtModule = defineNuxtModule<Exclude<KVModuleOptions, false>>({
  meta: {
    configKey: "kv",
    name: "@vitehub/kv/nuxt",
  },
  setup(inlineOptions, nuxt) {
    const currentNuxt = nuxt as NuxtLike
    const topLevelOptions = currentNuxt.options.kv

    if (topLevelOptions === false) {
      return
    }

    const kvConfig = topLevelOptions ?? inlineOptions
    const nitro = (currentNuxt.options.nitro ||= {})

    applyNitroConfig(nitro, kvConfig)
    currentNuxt.hook("nitro:config", (nitroConfig) => {
      applyNitroConfig(nitroConfig, kvConfig)
    })
  },
}) as unknown as KVNuxtModule

export default kvNuxtModule
