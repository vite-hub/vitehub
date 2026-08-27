import { createScheduleNitroConfig, hubSchedule } from "./vite.ts"

import type { ScheduleVitePluginOptions } from "./vite.ts"

export interface ScheduleNuxtModuleOptions extends ScheduleVitePluginOptions {}

type NuxtLike = {
  hook?: (name: "nitro:config", handler: (nitroConfig: Record<string, unknown>) => void | Promise<void>) => void
  options: {
    dev?: boolean
    nitro?: Record<string, unknown>
    rootDir?: string
    srcDir?: string
    vite?: {
      plugins?: unknown[]
    }
  }
}

function isScheduleVitePlugin(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as { name?: unknown }).name === "@vite-hub/schedule/vite")
}

export default function viteHubScheduleNuxtModule(options: ScheduleNuxtModuleOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt) return

  nuxt.options.vite ??= {}
  const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : []
  if (!plugins.some(isScheduleVitePlugin)) {
    plugins.push(hubSchedule(options))
  }
  nuxt.options.vite.plugins = plugins

  nuxt.hook?.("nitro:config", async (nitroConfig) => {
    const rootDir = nuxt.options.rootDir || process.cwd()
    const nitro = await createScheduleNitroConfig({
      ...options,
      command: nuxt.options.dev ? "serve" : "build",
      nitroOwnsPaths: true,
      nitro: nitroConfig,
      projectRoot: options.projectRoot || rootDir,
      root: nuxt.options.srcDir || rootDir,
    })
    if (nitro) Object.assign(nitroConfig, nitro)
  })
}
