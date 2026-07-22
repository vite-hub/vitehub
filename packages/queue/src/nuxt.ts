import { createQueueNitroConfig, hubQueue } from "./vite.ts"

import type { QueueModuleOptions } from "./types.ts"
import type { QueueVitePlugin } from "./vite.ts"

export type QueueNuxtModuleOptions = QueueModuleOptions

type NuxtLike = {
  hook?: (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => void | Promise<void>) => void
  options: {
    dev?: boolean
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: {
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

  nuxt.options.vite ??= {}
  const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : []
  const existingPlugin = findQueueVitePlugin(plugins)
  const plugin = existingPlugin || hubQueue(options)
  if (!existingPlugin) plugins.push(plugin)
  nuxt.options.vite.plugins = plugins

  nuxt.hook?.("nitro:config", async (nitroConfig) => {
    const projectRoot = nuxt.options.rootDir || process.cwd()
    const nitro = await createQueueNitroConfig(plugin, {
      nitro: nitroConfig,
      projectRoot,
      root: nuxt.options.srcDir || projectRoot,
      serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
    })
    Object.assign(nitroConfig, nitro)
  })
}
