import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"

import type { Plugin, PluginOption, UserConfig } from "vite"

type NuxtLike = {
  hook?: (name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) => void
  options: {
    alias?: Record<string, string>
    dev?: boolean
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: UserConfig
  }
}

type QueueNitroConfigHandler = (options: {
  nitro: Record<string, unknown>
  projectRoot: string
  root: string
  serverDirs?: string[]
}) => Promise<Record<string, unknown>>

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

function queueNitroConfigHandler(plugin: Plugin): QueueNitroConfigHandler | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      queue?: {
        createNitroConfig?: QueueNitroConfigHandler
      }
    }
  }).vitehub?.queue?.createNitroConfig
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
  const serverDirs = nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined
  let config: UserConfig & {
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_SERVER_DIRS]?: string[]
    nitro?: Record<string, unknown>
  } = {
    [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    ...(serverDirs ? { [VITEHUB_SERVER_DIRS]: serverDirs } : {}),
    build: {},
    nitro: nitroConfig,
    resolve: {
      alias: nuxt.options.alias,
    },
    root: nuxt.options.srcDir || nuxt.options.rootDir || process.cwd(),
    server: {},
  }

  for (const plugin of plugins) {
    const handler = configHandler(plugin)
    if (handler) {
      const result = await handler.call({} as never, config, environment)
      if (result) {
        const { nitro, ...viteConfig } = result as UserConfig & { nitro?: Record<string, unknown> }
        config = mergeConfig(config, viteConfig)
        if (nitro) config.nitro = nitro as Record<string, unknown>
        config[VITEHUB_NITRO_CONFIG_CONTEXT] = true
        if (serverDirs) config[VITEHUB_SERVER_DIRS] = serverDirs
      }
    }

    const createQueueNitroConfig = queueNitroConfigHandler(plugin)
    if (createQueueNitroConfig) {
      const projectRoot = nuxt.options.rootDir || process.cwd()
      config.nitro = await createQueueNitroConfig({
        nitro: config.nitro || {},
        projectRoot,
        root: nuxt.options.srcDir || projectRoot,
        serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
      })
    }
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
  const existingPluginsByName = new Map(
    flattenPlugins(existing)
      .filter(plugin => plugin.name)
      .map(plugin => [plugin.name, plugin]),
  )
  const installedPlugins = [
    ...plugins.map(plugin => existingPluginsByName.get(plugin.name) || plugin),
    ...flattenPlugins(existing).filter(plugin =>
      (plugin.name.startsWith("@vite-hub/") || plugin.name.startsWith("vite-hub/"))
      && !plugins.some(candidate => candidate.name === plugin.name),
    ),
  ]

  nuxt.options.vite ??= {}
  const viteConfig = nuxt.options.vite as UserConfig & {
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_SERVER_DIRS]?: string[]
  }
  viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  if (nuxt.options.serverDir) viteConfig[VITEHUB_SERVER_DIRS] = [nuxt.options.serverDir]
  nuxt.options.vite.plugins = [
    ...plugins.filter(plugin => !existingNames.has(plugin.name)),
    ...existing,
  ] as PluginOption[]
  nuxt.hook?.("nitro:config", config => applyNitroConfig(installedPlugins, config, nuxt))
}
