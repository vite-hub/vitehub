import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { generateProviderOutputs, queuePackageName } from "./internal/vite-build.ts"
import queueNitroModule from "./nitro/module.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin, ResolvedConfig } from "vite"

export type QueueVitePlugin = Plugin & { nitro: NitroModule }

export { createCloudflareQueueConfig, type CloudflareQueueConfig, type CloudflareQueueConfigOptions } from "./internal/vite-build.ts"

const mergeNoExternal = createNoExternalMerger(queuePackageName)

export function hubQueue(): QueueVitePlugin {
  let resolved: ResolvedConfig | undefined
  let queue: QueueModuleOptions | undefined

  return {
    name: "@vitehub/queue/vite",
    nitro: queueNitroModule,
    config(config) {
      queue = config.queue
    },
    configResolved(config) {
      resolved = config
      queue = config.queue ?? queue
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async closeBundle() {
      if (!resolved || resolved.command === "serve") {
        return
      }
      await generateProviderOutputs({
        clientOutDir: resolved.build.outDir,
        queue,
        rootDir: resolved.root,
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
