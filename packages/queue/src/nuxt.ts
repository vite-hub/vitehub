import { nuxtNitroRuntimeVersion, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_NITRO_RUNTIME_VERSION } from "@vite-hub/internal/build/vite"
import { resolve } from "node:path"
import { createQueueNitroConfig, hubQueue } from "./vite.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { QueueVitePlugin } from "./vite.ts"

export type QueueNuxtModuleOptions = QueueModuleOptions

type NuxtLike = {
  _version: string
  hook?: {
    (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => void | Promise<void>): void
    (name: "prepare:types", handler: (context: { references: { path: string }[] }) => void): void
  }
  options: {
    dev?: boolean
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: {
      [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
      [VITEHUB_NITRO_RUNTIME_VERSION]?: 2 | 3
      plugins?: unknown[]
    }
  }
}

function isQueueVitePlugin(value: unknown): value is QueueVitePlugin {
  return Boolean(value && typeof value === "object" && (value as { name?: unknown }).name === "@vite-hub/queue/vite")
}

function findQueueVitePlugin(plugins: unknown[]): QueueVitePlugin | undefined {
  return plugins.flat(Infinity).find(isQueueVitePlugin)
}

export default function viteHubQueueNuxtModule(options: QueueNuxtModuleOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt) return

  nuxt.hook?.("prepare:types", (context) => {
    context.references.push({ path: resolve(nuxt.options.rootDir || process.cwd(), ".vitehub/queue.d.ts") })
  })

  const nitroVersion = nuxtNitroRuntimeVersion(nuxt._version)
  nuxt.options.vite ??= {}
  nuxt.options.vite[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  nuxt.options.vite[VITEHUB_NITRO_RUNTIME_VERSION] = nitroVersion
  const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : []
  const existingPlugin = findQueueVitePlugin(plugins)
  const plugin = existingPlugin || hubQueue(options)
  if (!existingPlugin) plugins.push(plugin)
  nuxt.options.vite.plugins = plugins

  nuxt.hook?.("nitro:config", async (nitroConfig) => {
    const projectRoot = nuxt.options.rootDir || process.cwd()
    const nitro = await createQueueNitroConfig(plugin, {
      development: nuxt.options.dev,
      nitro: nitroConfig,
      nitroVersion,
      projectRoot,
      root: nuxt.options.srcDir || projectRoot,
      serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
    })
    Object.assign(nitroConfig, nitro)
  })
}
