import { createScheduleNitroConfig, hubSchedule } from "./vite.ts"

import type { ScheduleVitePlugin, ScheduleVitePluginOptions } from "./vite.ts"

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

function isScheduleVitePlugin(value: unknown): value is ScheduleVitePlugin {
  return Boolean(value && typeof value === "object" && (value as { name?: unknown }).name === "@vite-hub/schedule/vite")
}

export default function viteHubScheduleNuxtModule(options: ScheduleNuxtModuleOptions = {}, nuxt?: NuxtLike): void {
  if (!nuxt) return

  nuxt.options.vite ??= {}
  const plugins = Array.isArray(nuxt.options.vite.plugins) ? nuxt.options.vite.plugins : []
  const plugin = plugins.find(isScheduleVitePlugin) ?? hubSchedule(options)
  if (!plugins.includes(plugin)) plugins.push(plugin)
  nuxt.options.vite.plugins = plugins

  nuxt.hook?.("nitro:config", async (nitroConfig) => {
    // Nuxt does not install Nitro modules exposed by Vite plugins itself.
    const modules = Array.isArray(nitroConfig.modules) ? nitroConfig.modules : []
    if (plugin.nitro && !modules.includes(plugin.nitro)) modules.push(plugin.nitro)
    nitroConfig.modules = modules
    const rootDir = nuxt.options.rootDir || process.cwd()
    const nitro = await createScheduleNitroConfig({
      ...options,
      command: nuxt.options.dev ? "serve" : "build",
      nitroOwnsPaths: true,
      nitro: nitroConfig,
      plugins: nuxt.options.vite?.plugins,
      projectRoot: options.projectRoot || rootDir,
      root: nuxt.options.srcDir || rootDir,
    })
    if (nitro) Object.assign(nitroConfig, nitro)
  })
}
