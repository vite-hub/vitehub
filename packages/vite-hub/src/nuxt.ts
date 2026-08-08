import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import hubAuthNuxt from "@vite-hub/auth/nuxt"
import { hubDb as hubDatabaseNuxt } from "@vite-hub/database/nuxt"
import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"

import type { Plugin, PluginOption, UserConfig } from "vite"

const databaseRuntimeState = fileURLToPath(new URL("./_internal/database/runtime/state", import.meta.url))

type NuxtLike = {
  hook?: (name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) => void
  options: {
    alias?: Record<string, string>
    app?: {
      baseURL?: string
    }
    buildDir: string
    dev?: boolean
    imports?: {
      imports?: Array<{ as?: string, from: string, name: string }>
    }
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: UserConfig
    vitehub?: Parameters<typeof vitehub>[0]
  }
}

const agentVueComposables = ["useAgent", "useChat"]

function addAgentVueImports(nuxt: NuxtLike): void {
  nuxt.options.imports ??= {}
  const imports = (nuxt.options.imports.imports ??= [])
  for (const name of agentVueComposables) {
    const existing = imports.find(entry => (entry.as ?? entry.name) === name)
    if (existing && existing.from !== "vite-hub/agent/vue") {
      throw new TypeError(`[vitehub] Cannot auto-import ${name} from vite-hub/agent/vue because it is already configured from ${existing.from}.`)
    }
    if (!existing) imports.push({ from: "vite-hub/agent/vue", name })
  }
}

type QueueNitroConfigHandler = (options: {
  development?: boolean
  nitro: Record<string, unknown>
  projectRoot: string
  root: string
  serverDirs?: string[]
}) => Promise<Record<string, unknown>>

type WorkflowNitroConfigHandler = (options: {
  nitro: Record<string, unknown>
  projectRoot: string
  serverDirs?: string[]
  transformRegistry?: (code: string, id: string) => string | Promise<string>
}) => Promise<Record<string, unknown>>

type WorkflowRegistryTransform = (code: string, id: string) => string | Promise<string>

function agentWorkflowRegistryTransform(plugin: Plugin): WorkflowRegistryTransform | undefined {
  return (plugin as Plugin & {
    vitehub?: { agent?: { transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string> } }
  }).vitehub?.agent?.transformWorkflowRegistry
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

function queueNitroConfigHandler(plugin: Plugin): QueueNitroConfigHandler | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      queue?: {
        createNitroConfig?: QueueNitroConfigHandler
      }
    }
  }).vitehub?.queue?.createNitroConfig
}

function workflowNitroConfigHandler(plugin: Plugin): WorkflowNitroConfigHandler | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      workflow?: {
        createNitroConfig?: WorkflowNitroConfigHandler
      }
    }
  }).vitehub?.workflow?.createNitroConfig
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
  const generatedRoot = join(nuxt.options.buildDir, "vitehub")
  let config = mergeConfig({
    resolve: {
      alias: nuxt.options.alias,
    },
    root: nuxt.options.rootDir || process.cwd(),
  }, nuxt.options.vite ?? {}) as UserConfig & {
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_SERVER_DIRS]?: string[]
    nitro?: Record<string, unknown>
  }
  config[VITEHUB_GENERATED_ROOT] = generatedRoot
  config[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  if (serverDirs) config[VITEHUB_SERVER_DIRS] = serverDirs
  config.build ??= {}
  config.nitro = nitroConfig
  config.server ??= {}
  const transformWorkflowRegistry = plugins.map(agentWorkflowRegistryTransform).find(Boolean)

  for (const plugin of plugins) {
    const handler = configHandler(plugin)
    if (handler) {
      const result = await handler.call({} as never, config, environment)
      if (result) {
        const { nitro, ...viteConfig } = result as UserConfig & { nitro?: Record<string, unknown> }
        config = mergeConfig(config, viteConfig)
        if (nitro) config.nitro = nitro as Record<string, unknown>
        config[VITEHUB_GENERATED_ROOT] = generatedRoot
        config[VITEHUB_NITRO_CONFIG_CONTEXT] = true
        if (serverDirs) config[VITEHUB_SERVER_DIRS] = serverDirs
      }
    }

    const createQueueNitroConfig = queueNitroConfigHandler(plugin)
    if (createQueueNitroConfig) {
      const projectRoot = nuxt.options.rootDir || process.cwd()
      config.nitro = await createQueueNitroConfig({
        development: nuxt.options.dev,
        nitro: config.nitro || {},
        projectRoot,
        root: projectRoot,
        serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
      })
    }

    const createWorkflowNitroConfig = workflowNitroConfigHandler(plugin)
    if (createWorkflowNitroConfig) {
      const projectRoot = nuxt.options.rootDir || process.cwd()
      config.nitro = await createWorkflowNitroConfig({
        nitro: config.nitro || {},
        projectRoot,
        serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
        transformRegistry: transformWorkflowRegistry,
      })
    }
  }

  if (config.nitro) Object.assign(nitroConfig, config.nitro)
}

type ViteHubNuxtModule = {
  (inlineOptions: Parameters<typeof vitehub>[0] | undefined, nuxt?: NuxtLike): Promise<void>
  getMeta: () => {
    configKey: "vitehub"
    name: "vite-hub/nuxt"
  }
}

const viteHubNuxtModule: ViteHubNuxtModule = async function viteHubNuxtModule(inlineOptions, nuxt): Promise<void> {
  if (!nuxt) return

  const options = {
    ...nuxt.options.vitehub,
    ...inlineOptions,
  } as Parameters<typeof vitehub>[0]

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
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_SERVER_DIRS]?: string[]
  }
  viteConfig.define = {
    ...viteConfig.define,
    __VITEHUB_APP_BASE_URL__: JSON.stringify(nuxt.options.app?.baseURL || "/"),
  }
  viteConfig[VITEHUB_GENERATED_ROOT] = join(nuxt.options.buildDir, "vitehub")
  viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  if (nuxt.options.serverDir) viteConfig[VITEHUB_SERVER_DIRS] = [nuxt.options.serverDir]
  nuxt.options.vite.plugins = [
    ...plugins.filter(plugin => !existingNames.has(plugin.name)),
    ...existing,
  ] as PluginOption[]
  nuxt.hook?.("nitro:config", config => applyNitroConfig(installedPlugins, config, nuxt))
  if (options.agent) addAgentVueImports(nuxt)
  if (options.auth) {
    const envOptions = options.env || {}
    hubAuthNuxt({
      auth: options.auth === true ? undefined : options.auth,
      env: options.env === false
        ? false
        : { projectRoot: envOptions.projectRoot },
      importsFrom: "vite-hub/auth/vue",
      nitro: false,
    }, nuxt)
  }
  if (options.database) {
    const nuxtAlias = (nuxt.options.alias ??= {})
    nuxtAlias["@vite-hub/database/runtime/state"] ??= databaseRuntimeState
    await hubDatabaseNuxt(options.database === true ? {} : options.database)(undefined, nuxt)
    if (!nuxt.options.dev) {
      nuxt.hook?.("nitro:config", async (config) => {
        const alias = (config.alias ??= {}) as Record<string, string>
        alias["@vite-hub/database/runtime/state"]
          ??= nuxtAlias["@vite-hub/database/runtime/state"]
      })
    }
  }
}

viteHubNuxtModule.getMeta = () => ({
  configKey: "vitehub",
  name: "vite-hub/nuxt",
})

export default viteHubNuxtModule
