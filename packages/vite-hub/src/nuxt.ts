import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import hubAuthNuxt from "@vite-hub/auth/nuxt"
import { hubDb as hubDatabaseNuxt } from "@vite-hub/database/nuxt"
import { resolveEmailTemplateModulePath } from "@vite-hub/email/vite"
import { createEnvImportAliases } from "@vite-hub/env/vite"
import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"

import type { DatabaseNuxtIntegrationOptions } from "@vite-hub/database"
import type { EnvIntegrationOptions, EnvViteConfigOptions, EnvViteUserConfig } from "@vite-hub/env"
import type { Plugin, PluginOption, UserConfig } from "vite"

const databaseRuntimeState = fileURLToPath(new URL("./_internal/database/runtime/state", import.meta.url))
type ViteHubNuxtOptions = Omit<Parameters<typeof vitehub>[0], "database" | "env"> & {
  database?: boolean | Exclude<DatabaseNuxtIntegrationOptions, false>
  env?: false | EnvIntegrationOptions & EnvViteConfigOptions
}

type NuxtLike = {
  hook?: (name: "nitro:config", callback: (config: Record<string, unknown>) => Promise<void>) => void
  options: {
    alias?: Record<string, string>
    app?: {
      baseURL?: string
    }
    buildDir: string
    database?: DatabaseNuxtIntegrationOptions
    dev?: boolean
    imports?: {
      imports?: Array<{ as?: string, from: string, name: string }>
    }
    nitro?: Record<string, unknown>
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: UserConfig
    vitehub?: ViteHubNuxtOptions
    typescript?: Record<string, unknown>
  }
}

const agentVueComposables = ["useAgent", "useAgentInvocation", "useAgentInvocations", "useChat"]
const cloudflareTypes = fileURLToPath(new URL("./cloudflare-types.d.ts", import.meta.url))

function emailTemplateResolver(root: string): Plugin {
  return {
    name: "vite-hub/nuxt-email-templates",
    resolveId: id => resolveEmailTemplateModulePath(root, id),
  }
}

function installEmailTemplateResolver(config: Record<string, unknown>, root: string): void {
  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  const plugins = (rollupConfig.plugins ??= []) as Plugin[]
  if (!plugins.some(plugin => plugin.name === "vite-hub/nuxt-email-templates")) {
    plugins.push(emailTemplateResolver(root))
  }
}

function addTypeScriptDefaults(options: Record<string, unknown>, includes: string[], excludes: string[]): void {
  const typescript = (options.typescript ??= {}) as Record<string, unknown>
  const tsConfig = (typescript.tsConfig ??= {}) as Record<string, unknown>
  tsConfig.include = [...new Set([...((tsConfig.include as string[] | undefined) ?? []), ...includes])]
  if (excludes.length > 0) {
    tsConfig.exclude = [...new Set([...((tsConfig.exclude as string[] | undefined) ?? []), ...excludes])]
  }
}

function configuredProjectRoots(options: object, rootDir: string, viteRoot: string): string[] {
  return Object.entries(options as Record<string, unknown>)
    .filter((entry): entry is [string, { projectRoot: string }] => {
      const value = entry[1]
      return Boolean(value && typeof value === "object" && "projectRoot" in value && typeof value.projectRoot === "string")
    })
    .map(([name, value]) => resolve(name === "database" ? rootDir : viteRoot, value.projectRoot))
}

function addVueImports(nuxt: NuxtLike, from: string, names: string[]): void {
  nuxt.options.imports ??= {}
  const imports = (nuxt.options.imports.imports ??= [])
  for (const name of names) {
    const existing = imports.find(entry => (entry.as ?? entry.name) === name)
    if (existing && existing.from !== from) {
      throw new TypeError(`[vitehub] Cannot auto-import ${name} from ${from} because it is already configured from ${existing.from}.`)
    }
    if (!existing) imports.push({ from, name })
  }
}

function isEnvDeclarationNamespace(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind !== "env-variable")
}

function mergeEnvDeclarationNamespaces<T extends Record<string, unknown>>(
  existing: T | undefined,
  configured: T,
): T {
  const merged = { ...existing }
  for (const [key, value] of Object.entries(configured)) {
    const current = merged[key]
    merged[key] = isEnvDeclarationNamespace(current) && isEnvDeclarationNamespace(value)
      ? mergeEnvDeclarationNamespaces(current, value)
      : value
  }
  return merged as T
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

function deploymentOutputEnvPluginHandler(plugin: Plugin): ((envPlugin: Plugin) => void) | undefined {
  return (plugin as Plugin & {
    vitehub?: {
      deploymentOutput?: {
        useEnvPlugin?: (envPlugin: Plugin) => void
      }
    }
  }).vitehub?.deploymentOutput?.useEnvPlugin
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
    plugins,
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

  const orderedPlugins = [...plugins].sort((left, right) => {
    const order = (plugin: Plugin): number => plugin.name === "vite-hub/deployment-output"
      ? 2
      : plugin.enforce === "pre" ? -1 : plugin.enforce === "post" ? 1 : 0
    return order(left) - order(right)
  })
  for (const plugin of orderedPlugins) {
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
  (inlineOptions: ViteHubNuxtOptions | undefined, nuxt?: NuxtLike): Promise<void>
  getMeta: () => {
    configKey: "vitehub"
    name: "vite-hub/nuxt"
  }
}

const viteHubNuxtModule: ViteHubNuxtModule = async function viteHubNuxtModule(inlineOptions, nuxt): Promise<void> {
  if (!nuxt) return

  const moduleOptions = {
    ...nuxt.options.vitehub,
    ...inlineOptions,
  } as ViteHubNuxtOptions
  const configuredEnv = moduleOptions.env
  const envConfig = configuredEnv && typeof configuredEnv === "object"
    ? { define: configuredEnv.define, public: configuredEnv.public, server: configuredEnv.server }
    : undefined
  const envOptions = configuredEnv && typeof configuredEnv === "object"
    ? Object.fromEntries(Object.entries(configuredEnv).filter(([key]) => !["define", "public", "server"].includes(key)))
    : configuredEnv
  const options = {
    ...moduleOptions,
    env: envOptions,
  } as Parameters<typeof vitehub>[0]
  const plan = resolveDeploymentPlan(options.preset)
  const nitro = (nuxt.options.nitro ??= {})
  const nitroPreset = plan.preset === "cloudflare" && options.realtime
    ? "cloudflare-durable"
    : plan.nitroPreset
  if (typeof nitro.preset === "string" && normalizeNitroPreset(nitro.preset) !== nitroPreset) {
    throw new Error("[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with nitro.preset " + JSON.stringify(nitro.preset) + ".")
  }
  nitro.preset = nitroPreset
  if (plan.preset === "cloudflare") {
    const wasm = (nitro.wasm ??= {}) as Record<string, unknown>
    wasm.lazy ??= true
  }
  const rootDir = nuxt.options.rootDir || process.cwd()
  const viteRoot = resolve(rootDir, typeof nuxt.options.vite?.root === "string" ? nuxt.options.vite.root : rootDir)
  const projectRoot = resolveViteHubProjectRoot(viteRoot)
  nuxt.options.vite ??= {}
  const viteConfig = nuxt.options.vite as UserConfig & EnvViteUserConfig & {
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_SERVER_DIRS]?: string[]
  }
  if (envConfig && Object.values(envConfig).some(Boolean)) {
    const existingEnv = viteConfig.env ?? {}
    viteConfig.env = {
      ...existingEnv,
      ...(envConfig.define ? { define: mergeEnvDeclarationNamespaces(existingEnv.define, envConfig.define) } : {}),
      ...(envConfig.public ? { public: mergeEnvDeclarationNamespaces(existingEnv.public, envConfig.public) } : {}),
      ...(envConfig.server ? { server: mergeEnvDeclarationNamespaces(existingEnv.server, envConfig.server) } : {}),
    }
  }
  const configuredOptions = options.database && nuxt.options.database && typeof nuxt.options.database === "object"
    ? {
        ...options,
        database: {
          ...nuxt.options.database,
          ...(options.database === true ? {} : options.database),
        },
      }
    : options
  const secondaryProjectRoots = configuredProjectRoots(configuredOptions, rootDir, viteRoot)
    .filter(root => root !== projectRoot)
  const generatedTypes = [
    relative(nuxt.options.buildDir, join(projectRoot, ".vitehub/types.d.ts")),
    ...secondaryProjectRoots
      .map(root => relative(nuxt.options.buildDir, join(root, ".vitehub/**/*.d.ts"))),
  ]
  const generatedData = secondaryProjectRoots
    .map(root => relative(nuxt.options.buildDir, join(root, ".vitehub/data/**/*.d.ts")))
  if (options.preset === "cloudflare") generatedTypes.push(relative(nuxt.options.buildDir, cloudflareTypes))
  addTypeScriptDefaults(nuxt.options, generatedTypes, generatedData)
  addTypeScriptDefaults((nuxt.options.nitro ??= {}), generatedTypes, generatedData)
  if (options.database) {
    const databaseOptions = options.database === true ? {} : options.database
    await hubDatabaseNuxt({
      ...(options.preset === "cloudflare" ? { driver: "d1" as const } : {}),
      ...databaseOptions,
    })(undefined, nuxt)
  }

  const installedPlugins = flattenPlugins(vitehub(options as Parameters<typeof vitehub>[0]))
    .filter(plugin => !(options.database && plugin.name === "@vite-hub/database/vite"))
  const plugins = installedPlugins.filter(plugin => plugin.name !== "vite-hub/deployment-output")
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
  const replayPlugins = [
    ...installedPlugins.map(plugin => existingPluginsByName.get(plugin.name) || plugin),
    ...flattenPlugins(existing).filter(plugin =>
      (plugin.name.startsWith("@vite-hub/") || plugin.name.startsWith("vite-hub/"))
      && !plugins.some(candidate => candidate.name === plugin.name),
    ),
  ]
  const envPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/env/vite") as Plugin & {
    api?: {
      prepareTypes?: (config: EnvViteConfigOptions | undefined, viteRoot: string) => Promise<void>
      resolveProjectRoot?: (viteRoot: string) => string
    }
  } | undefined
  if (envPlugin) {
    for (const plugin of replayPlugins) deploymentOutputEnvPluginHandler(plugin)?.(envPlugin)
  }
  if (options.env !== false) await envPlugin?.api?.prepareTypes?.(viteConfig.env, viteRoot)
  const emailPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/email/vite") as Plugin & {
    api?: { prepareTypes?: (options: { materialize?: boolean, projectRoot: string, serverDirs?: string[] }) => Promise<Record<string, string>> }
  } | undefined
  const emailTemplatePaths = await emailPlugin?.api?.prepareTypes?.({
    materialize: true,
    projectRoot,
    serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
  }) ?? {}
  const emailCleanupPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/email/optional-peer-resolver") as Plugin & {
    api?: { prepareTypes?: (root: string) => Promise<void> }
  } | undefined
  if (!emailPlugin) await emailCleanupPlugin?.api?.prepareTypes?.(projectRoot)
  const typesPlugin = replayPlugins.find(plugin => plugin.name === "vite-hub/types") as Plugin & {
    api?: { prepareTypes?: (root: string) => Promise<void> }
  } | undefined
  await typesPlugin?.api?.prepareTypes?.(projectRoot)

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
  const configuredEnvProjectRootOption = options.env && typeof options.env === "object"
    ? options.env.projectRoot
    : undefined
  const configuredEnvProjectRoot = configuredEnvProjectRootOption
    ? resolve(viteRoot, configuredEnvProjectRootOption)
    : undefined
  const envProjectRoot = envPlugin?.api?.resolveProjectRoot?.(viteRoot) ?? configuredEnvProjectRoot ?? projectRoot
  if (envPlugin?.api?.resolveProjectRoot && configuredEnvProjectRoot) {
    if (configuredEnvProjectRoot !== envProjectRoot) {
      throw new TypeError(`[vitehub] Env projectRoot ${JSON.stringify(configuredEnvProjectRootOption)} conflicts with the installed Env Vite plugin.`)
    }
  }
  const generatedAliases = {
    ...(options.env === false ? {} : createEnvImportAliases({ projectRoot: envProjectRoot })),
    ...(!nuxt.options.dev ? Object.fromEntries(Object.entries(emailTemplatePaths).map(([name, path]) => [
        `#vitehub/emails/${name}`,
        path,
      ])) : {}),
    ...(emailPlugin && !nuxt.options.dev
      ? { "#vitehub/emails": join(projectRoot, ".vitehub/email/templates") }
      : {}),
  }
  nuxt.hook?.("nitro:config", async (config) => {
    await applyNitroConfig(replayPlugins, config, nuxt)
    if (emailPlugin && nuxt.options.dev) {
      installEmailTemplateResolver(config, join(projectRoot, ".vitehub/email/templates"))
    }
    const alias = (config.alias ??= {}) as Record<string, string>
    for (const [name, path] of Object.entries(generatedAliases)) alias[name] ??= path
  })
  if (options.agent) addVueImports(nuxt, "vite-hub/agent/vue", agentVueComposables)
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
  const nuxtAlias = (nuxt.options.alias ??= {})
  const nitroAlias = ((nuxt.options.nitro ??= {}).alias ??= {}) as Record<string, string>
  if (emailPlugin && nuxt.options.dev) {
    installEmailTemplateResolver(nuxt.options.nitro, join(projectRoot, ".vitehub/email/templates"))
  }
  for (const [name, path] of Object.entries(generatedAliases)) {
    nuxtAlias[name] ??= path
    nitroAlias[name] ??= path
  }
  if (options.realtime) {
    addVueImports(nuxt, "vite-hub/realtime", ["defineRealtime"])
    addVueImports(nuxt, "vite-hub/realtime/vue", ["useRealtimeTiptap"])
  }
  if (options.database) {
    const nuxtAlias = (nuxt.options.alias ??= {})
    nuxtAlias["@vite-hub/database/runtime/state"] ??= databaseRuntimeState
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
