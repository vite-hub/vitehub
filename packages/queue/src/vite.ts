import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { detectHosting } from "./internal/hosting.ts"
import { defaultCompatibilityDate, generateProviderOutputs, queuePackageName } from "./internal/vite-build.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { Plugin, UserConfig } from "vite"

export type QueueVitePlugin = Plugin

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

function resolveRootDir(configRoot: string | undefined) {
  return resolve(process.cwd(), configRoot || ".")
}

function resolveClientOutDir(userConfig: UserConfig) {
  return typeof userConfig.build?.outDir === "string" ? userConfig.build.outDir : "dist/client"
}

function writeBuildInfo(rootDir: string, queue: QueueModuleOptions | undefined) {
  const generatedDir = resolve(rootDir, ".vitehub", "queue")
  mkdirSync(generatedDir, { recursive: true })
  writeFileSync(resolve(generatedDir, "build-state.json"), `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    hosting: detectHosting({ preset: process.env.NITRO_PRESET }),
    queue: queue || null,
  }, null, 2)}\n`, "utf8")
}

export function hubQueue(): QueueVitePlugin {
  let rawConfig: UserConfig = {}
  let rootDir = process.cwd()
  let command: "build" | "serve" = "serve"

  return {
    name: "@vitehub/queue/vite",
    config(config, env) {
      rawConfig = config
      rootDir = resolveRootDir(typeof config.root === "string" ? config.root : undefined)
      command = env.command
      writeBuildInfo(rootDir, config.queue)
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
        clientOutDir: resolveClientOutDir(rawConfig),
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
