import { defineNuxtModule } from "@nuxt/kit"
import type { NitroConfig } from "nitro/types"

import type { QueueModuleOptions } from "../types.ts"

const NITRO_MODULE_ID = "@vitehub/queue/nitro"
type QueueNuxtOptions = Exclude<QueueModuleOptions, false>

function installQueueNitroModule(nitro: NitroConfig, queue: QueueModuleOptions | undefined) {
  nitro.modules ||= []
  if (!nitro.modules.includes(NITRO_MODULE_ID)) nitro.modules.push(NITRO_MODULE_ID)
  if (queue !== undefined) nitro.queue = queue
}

const queueNuxtModule: ReturnType<typeof defineNuxtModule<QueueNuxtOptions>> = defineNuxtModule<QueueNuxtOptions>({
  meta: { configKey: "queue", name: "@vitehub/queue/nuxt" },
  setup(inlineOptions: QueueNuxtOptions, nuxt: { options: Record<string, any>; hook: (...args: any[]) => unknown }) {
    const nuxtOptions = nuxt.options as Record<string, any>
    const topLevel = nuxtOptions.queue as QueueModuleOptions | false | undefined
    if (topLevel === false) return

    const queue = topLevel ?? inlineOptions
    const nitro = nuxtOptions.nitro ||= {}
    installQueueNitroModule(nitro, queue)
    ;(nuxt.hook as any)("nitro:config", (config: NitroConfig) => installQueueNitroModule(config, queue))
  },
})

export default queueNuxtModule
