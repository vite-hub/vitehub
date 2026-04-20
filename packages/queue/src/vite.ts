import queueNitroModule from "./nitro/module.ts"
import { resolve } from "node:path"

import { generateProviderOutputs, queuePackageName } from "./internal/vite-build.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { NitroModule } from "nitro/types"
import type { Plugin, UserConfig } from "vite"

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
  let rawConfig: UserConfig = {}
  let rootDir = process.cwd()
  let command: "build" | "serve" = "serve"

  return {
    name: "@vitehub/queue/vite",
    nitro: queueNitroModule,
    config(config, env) {
      rawConfig = config
      rootDir = resolve(process.cwd(), typeof config.root === "string" ? config.root : ".")
      command = env.command
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
        clientOutDir: typeof rawConfig.build?.outDir === "string" ? rawConfig.build.outDir : "dist/client",
        queue: rawConfig.queue,
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
