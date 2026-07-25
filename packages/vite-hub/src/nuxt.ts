import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"

import type { Plugin, PluginOption, UserConfig } from "vite"

type NuxtLike = {
  hook?: (name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) => void
  options: {
    dev?: boolean
    rootDir?: string
    vite?: UserConfig
  }
}

function flattenPlugins(options: readonly unknown[]): Plugin[] {
  const plugins: Plugin[] = []
  for (const option of options) {
    if (Array.isArray(option)) plugins.push(...flattenPlugins(option))
    else if (option && typeof option === "object" && "name" in option) plugins.push(option as Plugin)
  }
  return plugins
}

function configHandler(plugin: Plugin) {
  if (typeof plugin.config === "function") return plugin.config
  return plugin.config?.handler
}

function withoutDeploymentOutput(options: readonly unknown[]): unknown[] {
  return options.flatMap((option) => {
    if (Array.isArray(option)) return [withoutDeploymentOutput(option)]
    if (option && typeof option === "object" && "name" in option && option.name === "vite-hub/deployment-output") {
      return []
    }
    return [option]
  })
}

async function applyNitroConfig(plugins: Plugin[], nitroConfig: Record<string, unknown>, nuxt: NuxtLike) {
  const environment = {
    command: nuxt.options.dev ? "serve" : "build",
    isPreview: false,
    isSsrBuild: true,
    mode: nuxt.options.dev ? "development" : "production",
  } as const
  let config: UserConfig & { nitro?: Record<string, unknown> } = {
    build: {},
    nitro: nitroConfig,
    root: nuxt.options.rootDir || process.cwd(),
    server: {},
  }

  for (const plugin of plugins) {
    const handler = configHandler(plugin)
    if (!handler) continue
    const result = await handler.call({} as never, config, environment)
    if (result) config = mergeConfig(config, result)
  }

  if (config.nitro) Object.assign(nitroConfig, config.nitro)
}

export default function viteHubNuxtModule(options: Parameters<typeof vitehub>[0], nuxt?: NuxtLike): void {
  if (!nuxt) return

  const plugins = flattenPlugins(vitehub(options))
    .filter(plugin => plugin.name !== "vite-hub/deployment-output")
  const existing = withoutDeploymentOutput(
    Array.isArray(nuxt.options.vite?.plugins) ? nuxt.options.vite.plugins : [],
  )
  const existingNames = new Set(
    flattenPlugins(existing)
      .map(plugin => plugin.name)
      .filter(Boolean),
  )

  nuxt.options.vite ??= {}
  nuxt.options.vite.plugins = [
    ...plugins.filter(plugin => !existingNames.has(plugin.name)),
    ...existing,
  ] as PluginOption[]
  nuxt.hook?.("nitro:config", config => applyNitroConfig(plugins, config, nuxt))
}
