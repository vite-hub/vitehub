import { defineNuxtModule } from "@nuxt/kit"
import type { NitroConfig } from "nitro/types"
import type { NuxtModule } from "@nuxt/schema"

import type { QueueModuleOptions } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/queue/nitro"
type QueueNuxtOptions = Exclude<QueueModuleOptions, false>

function installQueueNitroModule(nitro: NitroConfig, queue: QueueModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) nitro.modules.push(NITRO_MODULE_ID)
  if (queue !== undefined) nitro.queue = queue
}

const queueNuxtModule: NuxtModule<QueueNuxtOptions, QueueNuxtOptions, false> = defineNuxtModule<QueueNuxtOptions>({
  meta: { configKey: "queue", name: "@vitehub/queue/nuxt" },
  setup(inlineOptions, nuxt) {
    const topLevel = nuxt.options.queue
    if (topLevel === false) return

    const queue = topLevel ?? inlineOptions
    nuxt.options.nitro ||= {}
    installQueueNitroModule(nuxt.options.nitro, queue)
    nuxt.hook("nitro:config", config => installQueueNitroModule(config, queue))
  },
})

export default queueNuxtModule

declare module "@nuxt/schema" {
  interface NuxtConfig {
    nitro?: NitroConfig
    queue?: QueueModuleOptions
  }
  interface NuxtOptions {
    nitro?: NitroConfig
    queue?: QueueModuleOptions
  }
  interface NuxtHooks {
    "nitro:config": (config: NitroConfig) => void | Promise<void>
  }
}
