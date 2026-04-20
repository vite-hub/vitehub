import queueNitroModule from "./nitro/module.ts"

import { generateProviderOutputs, queuePackageName } from "./internal/vite-build.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin } from "vite"

export type QueueVitePlugin = Plugin & { nitro: NitroModule }

export { createCloudflareQueueConfig, type CloudflareQueueConfig, type CloudflareQueueConfigOptions } from "./internal/vite-build.ts"

function mergeNoExternal(current: boolean | string | RegExp | (string | RegExp)[] | undefined) {
  if (current === true) {
    return true
  }

  if (!current) {
    return [queuePackageName]
  }

  const values = Array.isArray(current) ? current : [current]
  return values.some(value => value === queuePackageName) ? values : [...values, queuePackageName]
}

function isQueueServerEnvironment(name: string, config: { consumer?: string }) {
  return name === "ssr" || config.consumer === "server"
}

export function hubQueue(): QueueVitePlugin {
  let clientOutDir = "dist"
  let queue: QueueModuleOptions | undefined
  let rootDir = process.cwd()
  let command: "build" | "serve" = "serve"

  return {
    name: "@vitehub/queue/vite",
    nitro: queueNitroModule,
    config(config, env) {
      queue = config.queue
      command = env.command
    },
    configResolved(config) {
      clientOutDir = config.build.outDir
      queue = config.queue ?? queue
      rootDir = config.root
    },
    configEnvironment(name, config) {
      if (!isQueueServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: {
          noExternal: mergeNoExternal(config.resolve?.noExternal),
        },
      }
    },
    async closeBundle() {
      if (command === "serve") {
        return
      }

      await generateProviderOutputs({
        clientOutDir,
        queue,
        rootDir,
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
