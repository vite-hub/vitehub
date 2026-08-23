import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  resolveViteHubProjectRoot,
  VITEHUB_GENERATED_ROOT,
  VITEHUB_NITRO_CONFIG_CONTEXT,
  VITEHUB_SERVER_DIRS,
} from "@vite-hub/internal/build/vite"
import { normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import hubAuthNuxt from "@vite-hub/auth/nuxt"
import { hubDb as hubDatabaseNuxt } from "@vite-hub/database/nuxt"
import { resolveEmailTemplateModulePath } from "@vite-hub/email/vite"
import { createEnvImportAliases } from "@vite-hub/env/vite"
import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"
import { mergeGeneratedCollectionNitroConfig, type GeneratedCollectionHandler } from "./internal/types.ts"

import type { DatabaseNuxtIntegrationOptions } from "@vite-hub/database"
import type { EnvIntegrationOptions, EnvViteConfigOptions, EnvViteUserConfig } from "@vite-hub/env"
import type { HookHandler, Plugin, PluginOption, UserConfig } from "vite"

const databaseRuntimeState = fileURLToPath(new URL("./_internal/database/runtime/state", import.meta.url))
type ViteHubNuxtOptions = Omit<Parameters<typeof vitehub>[0], "database" | "env"> & {
  database?: boolean | Exclude<DatabaseNuxtIntegrationOptions, false>
  env?: false | (EnvIntegrationOptions & EnvViteConfigOptions)
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
      imports?: Array<{ as?: string; from: string; name: string }>
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
  // SAFETY: Nitro rollupConfig is an object namespace owned and initialized here.
  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  // SAFETY: Nitro rollup plugins use Vite's Plugin contract.
  const plugins = (rollupConfig.plugins ??= []) as Plugin[]
  if (!plugins.some(plugin => plugin.name === "vite-hub/nuxt-email-templates")) {
    plugins.push(emailTemplateResolver(root))
  }
}

type MarkdownTemplatePlugin = Omit<Plugin, "load" | "resolveId"> & {
  load: HookHandler<NonNullable<Plugin["load"]>>
  resolveId(
    this: ThisParameterType<HookHandler<NonNullable<Plugin["resolveId"]>>>,
    ...args: Parameters<HookHandler<NonNullable<Plugin["resolveId"]>>>
  ): Promise<string | undefined> | string | undefined
}

function markdownTemplateResolver(plugin: MarkdownTemplatePlugin): Plugin {
  return {
    name: "vite-hub/nuxt-markdown-templates",
    load(id, ...args) {
      // SAFETY: Object.create preserves the complete Rollup plugin context supplied as this.
      const context = Object.create(this) as typeof this
      Object.defineProperty(context, "resolve", {
        value: async (...resolveArgs: Parameters<typeof this.resolve>) => {
          const resolved = await this.resolve(...resolveArgs)
          return resolved && {
            ...resolved,
            id: resolved.id.startsWith("\0raw:") ? resolved.id.slice(5) : resolved.id,
          }
        },
      })
      return plugin.load.call(context, id.startsWith("\0raw:") ? id.slice(5) : id, ...args)
    },
    async resolveId(...args) {
      const resolved = await plugin.resolveId.call(this, ...args)
      return resolved?.startsWith("\0raw:") ? resolved.slice(5) : resolved
    },
  }
}

function pluginOptionHasName(option: PluginOption, name: string): boolean {
  if (Array.isArray(option)) return option.some(candidate => pluginOptionHasName(candidate, name))
  return Boolean(option && option.name === name)
}

function installMarkdownTemplateResolver(config: Record<string, unknown>, plugin: MarkdownTemplatePlugin | undefined): void {
  if (!plugin) return
  // SAFETY: Nitro rollupConfig is an object namespace owned and initialized here.
  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  // SAFETY: Nitro Rollup plugins use Vite's compatible Plugin contract.
  const configuredPlugins = rollupConfig.plugins as PluginOption | undefined
  const plugins = Array.isArray(configuredPlugins)
    ? configuredPlugins
    : configuredPlugins
      ? [configuredPlugins]
      : []
  rollupConfig.plugins = plugins
  if (!plugins.some(candidate => pluginOptionHasName(candidate, "vite-hub/nuxt-markdown-templates"))) {
    plugins.push(markdownTemplateResolver(plugin))
  }
}

function addTypeScriptDefaults(options: Record<string, unknown>, includes: string[], excludes: string[]): void {
  // SAFETY: The TypeScript namespace is initialized to the object contract mutated below.
  const typescript = (options.typescript ??= {}) as Record<string, unknown>
  // SAFETY: The tsConfig namespace is initialized to the object contract mutated below.
  const tsConfig = (typescript.tsConfig ??= {}) as Record<string, unknown>
  // SAFETY: Nuxt TypeScript include entries are string globs.
  tsConfig.include = [...new Set([...((tsConfig.include as string[] | undefined) ?? []), ...includes])]
  if (excludes.length > 0) {
    // SAFETY: Nuxt TypeScript exclude entries are string globs.
    tsConfig.exclude = [...new Set([...((tsConfig.exclude as string[] | undefined) ?? []), ...excludes])]
  }
}

function configuredProjectRoots(options: Parameters<typeof vitehub>[0], rootDir: string, viteRoot: string): string[] {
  return Object.entries(options)
    .filter((entry): entry is [string, { projectRoot: string }] => {
      const value = entry[1]
      return (
        Object(value) === value &&
        String(Reflect.get(Object(value), "projectRoot")) === Reflect.get(Object(value), "projectRoot")
      )
    })
    .map(([name, value]) => resolve(name === "database" ? rootDir : viteRoot, value.projectRoot))
}

function addVueImports(nuxt: NuxtLike, from: string, names: string[]): void {
  nuxt.options.imports ??= {}
  const imports = (nuxt.options.imports.imports ??= [])
  for (const name of names) {
    const existing = imports.find(entry => (entry.as ?? entry.name) === name)
    if (existing && existing.from !== from) {
      throw new TypeError(
        `[vitehub] Cannot auto-import ${name} from ${from} because it is already configured from ${existing.from}.`,
      )
    }
    if (!existing) imports.push({ from, name })
  }
}

function isEnvDeclarationNamespace(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value) && Reflect.get(Object(value), "kind") !== "env-variable"
}

function mergeEnvDeclarationNamespaces<T extends Record<string, unknown>>(existing: T | undefined, configured: T): T {
  const merged = { ...existing }
  for (const [key, value] of Object.entries(configured)) {
    const current = merged[key]
    merged[key] =
      isEnvDeclarationNamespace(current) && isEnvDeclarationNamespace(value)
        ? mergeEnvDeclarationNamespaces(current, value)
        : value
  }
  // SAFETY: Every assignment preserves the configured namespace's key and value contract.
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
  return (
    // SAFETY: ViteHub agent plugins own this optional metadata namespace.
    plugin as Plugin & {
      vitehub?: {
        agent?: {
          transformWorkflowRegistry?: (code: string, id: string) => string | Promise<string>
        }
      }
    }
  ).vitehub?.agent?.transformWorkflowRegistry
}

function flattenPlugins(options: readonly unknown[]): Plugin[] {
  const plugins: Plugin[] = []
  for (const option of options) {
    if (Array.isArray(option)) plugins.push(...flattenPlugins(option))
    else if (Object(option) === option && Reflect.has(Object(option), "name")) {
      // SAFETY: Vite plugin options with a name use the Plugin object contract.
      plugins.push(option as Plugin)
    }
  }
  return plugins
}

function configHandler(plugin: Plugin) {
  if (plugin.config instanceof Function) return plugin.config
  return plugin.config?.handler
}

function queueNitroConfigHandler(plugin: Plugin): QueueNitroConfigHandler | undefined {
  return (
    // SAFETY: ViteHub queue plugins own this optional metadata namespace.
    plugin as Plugin & {
      vitehub?: {
        queue?: {
          createNitroConfig?: QueueNitroConfigHandler
        }
      }
    }
  ).vitehub?.queue?.createNitroConfig
}

function workflowNitroConfigHandler(plugin: Plugin): WorkflowNitroConfigHandler | undefined {
  return (
    // SAFETY: ViteHub workflow plugins own this optional metadata namespace.
    plugin as Plugin & {
      vitehub?: {
        workflow?: {
          createNitroConfig?: WorkflowNitroConfigHandler
        }
      }
    }
  ).vitehub?.workflow?.createNitroConfig
}

function deploymentOutputEnvPluginHandler(plugin: Plugin): ((envPlugin: Plugin) => void) | undefined {
  return (
    // SAFETY: ViteHub deployment plugins own this optional metadata namespace.
    plugin as Plugin & {
      vitehub?: {
        deploymentOutput?: {
          useEnvPlugin?: (envPlugin: Plugin) => void
        }
      }
    }
  ).vitehub?.deploymentOutput?.useEnvPlugin
}

function withoutDeploymentOutput(options: readonly unknown[]): unknown[] {
  return options.flatMap(option => {
    if (Array.isArray(option)) return [withoutDeploymentOutput(option)]
    if (Object(option) === option && Reflect.get(Object(option), "name") === "vite-hub/deployment-output") {
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
  const mergedConfig: unknown = mergeConfig(
    {
      plugins,
      resolve: {
        alias: nuxt.options.alias,
      },
      root: nuxt.options.rootDir || process.cwd(),
    },
    nuxt.options.vite ?? {},
  )
  // SAFETY: mergeConfig preserves UserConfig and the ViteHub fields installed below.
  let config = mergedConfig as UserConfig & {
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
    const order = (plugin: Plugin): number =>
      plugin.name === "vite-hub/deployment-output"
        ? 2
        : plugin.enforce === "pre"
          ? -1
          : plugin.enforce === "post"
            ? 1
            : 0
    return order(left) - order(right)
  })
  for (const plugin of orderedPlugins) {
    const handler = configHandler(plugin)
    if (handler) {
      // SAFETY: Vite invokes config hooks with its internal plugin context; this replay does not use it.
      const result = await handler.call({} as never, config, environment)
      if (result) {
        // SAFETY: Vite config hooks return UserConfig, optionally extended with ViteHub Nitro state.
        const { nitro, ...viteConfig } = result as UserConfig & { nitro?: Record<string, unknown> }
        config = mergeConfig(config, viteConfig)
        // SAFETY: ViteHub config hooks own the Nitro object contract when they return it.
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

  // SAFETY: Nuxt merges only the declared ViteHub module option namespaces here.
  const moduleOptions = {
    ...nuxt.options.vitehub,
    ...inlineOptions,
  } as ViteHubNuxtOptions
  const configuredEnv = moduleOptions.env
  const envConfig = configuredEnv
    ? { define: configuredEnv.define, public: configuredEnv.public, server: configuredEnv.server }
    : undefined
  const envOptions = configuredEnv
    ? Object.fromEntries(Object.entries(configuredEnv).filter(([key]) => !["define", "public", "server"].includes(key)))
    : configuredEnv
  // SAFETY: vitehub() consumes the same public option object after Nuxt-only env fields are removed.
  const options = {
    ...moduleOptions,
    env: envOptions,
  } as Parameters<typeof vitehub>[0]
  const plan = resolveDeploymentPlan(options.preset)
  const nitro = (nuxt.options.nitro ??= {})
  const nitroPreset = plan.preset === "cloudflare" && options.realtime ? "cloudflare-durable" : plan.nitroPreset
  if (String(nitro.preset) === nitro.preset && normalizeNitroPreset(nitro.preset) !== nitroPreset) {
    throw new Error(
      "[vitehub] vitehub preset " +
        JSON.stringify(plan.preset) +
        " conflicts with nitro.preset " +
        JSON.stringify(nitro.preset) +
        ".",
    )
  }
  nitro.preset = nitroPreset
  if (plan.preset === "cloudflare") {
    // SAFETY: Nitro wasm configuration is an object namespace initialized here.
    const wasm = (nitro.wasm ??= {}) as Record<string, unknown>
    wasm.lazy ??= true
  }
  const rootDir = nuxt.options.rootDir || process.cwd()
  const viteRoot = resolve(
    rootDir,
    String(nuxt.options.vite?.root) === nuxt.options.vite?.root ? nuxt.options.vite.root : rootDir,
  )
  const projectRoot = resolveViteHubProjectRoot(viteRoot)
  nuxt.options.vite ??= {}
  // SAFETY: Nuxt's Vite config is extended with ViteHub symbol-keyed integration state.
  const viteConfig = nuxt.options.vite as UserConfig &
    EnvViteUserConfig & {
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
  const configuredOptions =
    options.database && Object(nuxt.options.database) === nuxt.options.database
      ? {
          ...options,
          database: {
            ...nuxt.options.database,
            ...(options.database === true ? {} : options.database),
          },
        }
      : options
  const secondaryProjectRoots = configuredProjectRoots(configuredOptions, rootDir, viteRoot).filter(
    root => root !== projectRoot,
  )
  const generatedTypes = [
    relative(nuxt.options.buildDir, join(projectRoot, ".vitehub/types.d.ts")),
    ...secondaryProjectRoots.map(root => relative(nuxt.options.buildDir, join(root, ".vitehub/**/*.d.ts"))),
  ]
  const generatedData = secondaryProjectRoots.map(root =>
    relative(nuxt.options.buildDir, join(root, ".vitehub/data/**/*.d.ts")),
  )
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

  // SAFETY: The normalized Nuxt options above are the public vitehub() option contract.
  const installedPlugins = flattenPlugins(vitehub(options as Parameters<typeof vitehub>[0])).filter(
    plugin => !(options.database && plugin.name === "@vite-hub/database/vite"),
  )
  const plugins = installedPlugins.filter(plugin => plugin.name !== "vite-hub/deployment-output")
  const existing = withoutDeploymentOutput(Array.isArray(nuxt.options.vite?.plugins) ? nuxt.options.vite.plugins : [])
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
    ...flattenPlugins(existing).filter(
      plugin =>
        (plugin.name.startsWith("@vite-hub/") || plugin.name.startsWith("vite-hub/")) &&
        !plugins.some(candidate => candidate.name === plugin.name),
    ),
  ]
  const envPluginCandidate: unknown = replayPlugins.find(plugin => plugin.name === "@vite-hub/env/vite")
  // SAFETY: The plugin name identifies the ViteHub Env plugin and its public preparation API.
  const envPlugin = envPluginCandidate as
    | (Plugin & {
        api?: {
          prepareTypes?: (config: EnvViteConfigOptions | undefined, viteRoot: string) => Promise<void>
          resolveProjectRoot?: (viteRoot: string) => string
        }
      })
    | undefined
  if (envPlugin) {
    for (const plugin of replayPlugins) deploymentOutputEnvPluginHandler(plugin)?.(envPlugin)
  }
  if (options.env !== false) await envPlugin?.api?.prepareTypes?.(viteConfig.env, viteRoot)
  const emailPluginCandidate: unknown = replayPlugins.find(plugin => plugin.name === "@vite-hub/email/vite")
  // SAFETY: The plugin name identifies the ViteHub Email plugin and its public preparation API.
  const emailPlugin = emailPluginCandidate as
    | (Plugin & {
        api?: {
          prepareTypes?: (options: {
            materialize?: boolean
            projectRoot: string
            serverDirs?: string[]
          }) => Promise<Record<string, string>>
        }
      })
    | undefined
  const markdownTemplatePluginCandidate: unknown = installedPlugins.find(
    plugin => plugin.name === "@vite-hub/markdown-template/vite",
  )
  // SAFETY: The canonical Markdown Template plugin name identifies the framework-owned function-hook contract.
  const markdownTemplatePlugin = markdownTemplatePluginCandidate as MarkdownTemplatePlugin | undefined
  const emailTemplatePaths =
    (await emailPlugin?.api?.prepareTypes?.({
      materialize: true,
      projectRoot,
      serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
    })) ?? {}
  const emailCleanupCandidate: unknown = replayPlugins.find(
    plugin => plugin.name === "@vite-hub/email/optional-peer-resolver",
  )
  // SAFETY: The plugin name identifies the ViteHub Email cleanup plugin preparation API.
  const emailCleanupPlugin = emailCleanupCandidate as
    | (Plugin & {
        api?: { prepareTypes?: (root: string) => Promise<void> }
      })
    | undefined
  if (!emailPlugin) await emailCleanupPlugin?.api?.prepareTypes?.(projectRoot)
  const typesPluginCandidate: unknown = replayPlugins.find(plugin => plugin.name === "vite-hub/types")
  // SAFETY: The plugin name identifies the ViteHub Types plugin preparation API.
  const typesPlugin = typesPluginCandidate as
    | (Plugin & {
        api?: {
          prepareTypes?: (options: {
            projectRoot: string
            serverDirs?: string[]
          }) => Promise<GeneratedCollectionHandler[]>
        }
      })
    | undefined
  const collectionHandlers =
    (await typesPlugin?.api?.prepareTypes?.({
      projectRoot,
      serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
    })) ?? []

  viteConfig.define = {
    ...viteConfig.define,
    __VITEHUB_APP_BASE_URL__: JSON.stringify(nuxt.options.app?.baseURL || "/"),
  }
  viteConfig[VITEHUB_GENERATED_ROOT] = join(nuxt.options.buildDir, "vitehub")
  viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  if (nuxt.options.serverDir) viteConfig[VITEHUB_SERVER_DIRS] = [nuxt.options.serverDir]
  const installedVitePlugins: unknown = [...plugins.filter(plugin => !existingNames.has(plugin.name)), ...existing]
  // SAFETY: Both arrays were normalized through flattenPlugins or preserved Vite plugin options.
  nuxt.options.vite.plugins = installedVitePlugins as PluginOption[]
  const configuredEnvProjectRootOption = options.env ? options.env.projectRoot : undefined
  const configuredEnvProjectRoot = configuredEnvProjectRootOption
    ? resolve(viteRoot, configuredEnvProjectRootOption)
    : undefined
  const envProjectRoot = envPlugin?.api?.resolveProjectRoot?.(viteRoot) ?? configuredEnvProjectRoot ?? projectRoot
  if (envPlugin?.api?.resolveProjectRoot && configuredEnvProjectRoot) {
    if (configuredEnvProjectRoot !== envProjectRoot) {
      throw new TypeError(
        `[vitehub] Env projectRoot ${JSON.stringify(configuredEnvProjectRootOption)} conflicts with the installed Env Vite plugin.`,
      )
    }
  }
  const generatedAliases = {
    ...(options.env === false ? {} : createEnvImportAliases({ projectRoot: envProjectRoot })),
    ...(!nuxt.options.dev
      ? Object.fromEntries(Object.entries(emailTemplatePaths).map(([name, path]) => [`#vitehub/emails/${name}`, path]))
      : {}),
    ...(emailPlugin && !nuxt.options.dev ? { "#vitehub/emails": join(projectRoot, ".vitehub/email/templates") } : {}),
  }
  nuxt.hook?.("nitro:config", async config => {
    await applyNitroConfig(replayPlugins, config, nuxt)
    Object.assign(config, mergeGeneratedCollectionNitroConfig(config, collectionHandlers))
    installMarkdownTemplateResolver(config, markdownTemplatePlugin)
    if (emailPlugin && nuxt.options.dev) {
      installEmailTemplateResolver(config, join(projectRoot, ".vitehub/email/templates"))
    }
    // SAFETY: Generated aliases are string-to-path entries in Nitro's alias namespace.
    const alias = (config.alias ??= {}) as Record<string, string>
    for (const [name, path] of Object.entries(generatedAliases)) alias[name] ??= path
  })
  if (options.agent) addVueImports(nuxt, "vite-hub/agent/vue", agentVueComposables)
  addVueImports(nuxt, "vite-hub/source/client", ["useCollection"])
  if (options.auth) {
    const envOptions = options.env || {}
    hubAuthNuxt(
      {
        auth: options.auth === true ? undefined : options.auth,
        env: options.env === false ? false : { projectRoot: envOptions.projectRoot },
        importsFrom: "vite-hub/auth/vue",
        nitro: false,
      },
      nuxt,
    )
  }
  const nuxtAlias = (nuxt.options.alias ??= {})
  // SAFETY: Generated aliases are string-to-path entries in Nitro's alias namespace.
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
      nuxt.hook?.("nitro:config", async config => {
        // SAFETY: Generated aliases are string-to-path entries in Nitro's alias namespace.
        const alias = (config.alias ??= {}) as Record<string, string>
        alias["@vite-hub/database/runtime/state"] ??= nuxtAlias["@vite-hub/database/runtime/state"]
      })
    }
  }
}

viteHubNuxtModule.getMeta = () => ({
  configKey: "vitehub",
  name: "vite-hub/nuxt",
})

export default viteHubNuxtModule
