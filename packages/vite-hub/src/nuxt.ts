import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { discoverAgentDefinitionEntries } from "@vite-hub/agent/vite"
import { resolveViteHubProjectRoot, VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import hubAuthNuxt from "@vite-hub/auth/nuxt"
import { resolveAuthViteConfig } from "@vite-hub/auth/vite"
import { hubDb as hubDatabaseNuxt } from "@vite-hub/database/nuxt"
import { resolveEmailTemplateModulePath } from "@vite-hub/email/vite"
import { createEnvImportAliases } from "@vite-hub/env/vite"
import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"
import { installConsoleInvocations } from "./console/runtime/server/invocations.ts"
import { serializeConsoleRefresh } from "./console/refresh.ts"
import { assertConsoleProductionAccess, consoleInvocationRootPlugin } from "./console/vite.ts"
import { mergeGeneratedNitroConfig, type GeneratedServerHandler } from "./internal/types.ts"

import type { DatabaseNuxtIntegrationOptions } from "@vite-hub/database"
import type { AuthModuleOptions } from "@vite-hub/auth"
import type { EnvIntegrationOptions, EnvViteConfigOptions, EnvViteUserConfig } from "@vite-hub/env"
import type { HookHandler, Plugin, PluginOption, ResolvedConfig, UserConfig } from "vite"

const databaseRuntimeState = fileURLToPath(new URL("./_internal/database/runtime/state", import.meta.url))
const consoleRuntimeRoot = fileURLToPath(new URL("./console/runtime", import.meta.url))
type NuxtPage = { file: string, name: string, path: string }
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
    devServerHandlers?: Array<{
      handler: (event: import("./console/runtime/server/request.ts").ConsoleRequestEvent) => void
      route?: string
    }>
    imports?: {
      imports?: Array<{ as?: string, from: string, name: string }>
    }
    modules?: unknown[]
    nitro?: Record<string, unknown>
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: UserConfig & { auth?: AuthModuleOptions }
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
  return Boolean(option && Reflect.get(Object(option), "name") === name)
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

const nitroRuntimeResolverNames = new Set([
  "@vite-hub/blob/vite",
  "@vite-hub/kv/vite",
])

const nitroConfigResolvedNames = new Set([
  ...nitroRuntimeResolverNames,
  "@vite-hub/sandbox/vite",
])

function pluginResolveIdHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["resolveId"]>> | undefined {
  if (typeof plugin.resolveId === "function") return plugin.resolveId
  return plugin.resolveId?.handler
}

function pluginLoadHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["load"]>> | undefined {
  if (typeof plugin.load === "function") return plugin.load
  return plugin.load?.handler
}

function pluginConfigResolvedHandler(plugin: Plugin): HookHandler<NonNullable<Plugin["configResolved"]>> | undefined {
  if (typeof plugin.configResolved === "function") return plugin.configResolved
  return plugin.configResolved?.handler
}

async function finalizeNitroReplayPlugins(plugins: Plugin[], config: UserConfig): Promise<void> {
  for (const plugin of plugins) {
    if (!nitroConfigResolvedNames.has(plugin.name)) continue
    const configResolved = pluginConfigResolvedHandler(plugin)
    if (!configResolved) continue
    // SAFETY: Nitro replay has applied every Vite config hook and normalized the fields used by ViteHub runtime owners.
    await configResolved.call({} as never, config as unknown as ResolvedConfig)
  }
}

function nitroRuntimeResolver(plugin: Plugin): Plugin | undefined {
  if (!nitroRuntimeResolverNames.has(plugin.name)) return
  const resolveId = pluginResolveIdHandler(plugin)
  const load = pluginLoadHandler(plugin)
  if (!resolveId && !load) return

  return {
    name: `vite-hub/nuxt-runtime-resolver:${plugin.name}`,
    ...(resolveId
      ? {
          resolveId(...args) {
            return resolveId.call(this, ...args)
          },
        }
      : {}),
    ...(load
      ? {
          load(...args) {
            return load.call(this, ...args)
          },
        }
      : {}),
  }
}

function installNitroRuntimeResolvers(config: Record<string, unknown>, plugins: Plugin[]): void {
  const resolvers = plugins.map(nitroRuntimeResolver).filter((plugin): plugin is Plugin => Boolean(plugin))
  if (!resolvers.length) return

  const rollupConfig = (config.rollupConfig ??= {}) as Record<string, unknown>
  const configuredPlugins = rollupConfig.plugins as PluginOption | undefined
  const nitroPlugins = Array.isArray(configuredPlugins)
    ? configuredPlugins
    : configuredPlugins
      ? [configuredPlugins]
      : []
  rollupConfig.plugins = nitroPlugins
  for (const resolver of resolvers) {
    if (!nitroPlugins.some(candidate => pluginOptionHasName(candidate, resolver.name))) nitroPlugins.push(resolver)
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

function renderConsoleNitroPlugin(projectRoot: string, agents: readonly { handler: string, name: string }[]): string {
  return [
    `import { installConsoleAgentDefinitions, installConsoleInvocations } from "vite-hub/console/server"`,
    ...agents.map((agent, index) => `import * as vitehubConsoleAgent${index} from ${JSON.stringify(pathToFileURL(agent.handler).href)}`),
    `const vitehubConsoleInvocations = installConsoleInvocations(${JSON.stringify(projectRoot)})`,
    `installConsoleAgentDefinitions([${agents.map((agent, index) => `{ definition: vitehubConsoleAgent${index}, fallbackName: ${JSON.stringify(agent.name)} }`).join(", ")}], vitehubConsoleInvocations)`,
    "export default function viteHubConsolePlugin() {}",
    "",
  ].join("\n")
}

async function writeConsoleNitroPlugin(
  file: string,
  projectRoot: string,
  agents: readonly { handler: string, name: string }[],
): Promise<void> {
  const contents = renderConsoleNitroPlugin(projectRoot, agents)
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(resolve(file, ".."), { recursive: true })
  await writeFile(file, contents, "utf8")
}

async function installConsole(
  nuxt: NuxtLike,
  projectRoot: string,
  discoveryRoot: string,
  serverDirs?: string[],
): Promise<void> {
  const uiModule = (await import("@vite-hub/ui/nuxt")).default
  const uiConfigured = (nuxt.options.modules ?? []).some((entry) => {
    const module = Array.isArray(entry) ? entry[0] : entry
    return module === "@vite-hub/ui/nuxt" || module === "vite-hub/ui/nuxt" || module === uiModule
  })
  if (!uiConfigured) {
    await Reflect.apply(uiModule, undefined, [{}, nuxt])
  }
  installConsoleInvocations(projectRoot)
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Nuxt exposes hook overloads, while this structural seam keeps narrow nitro-only test hosts assignable.
  const hookPages = nuxt.hook as unknown as ((name: "pages:extend", callback: (pages: NuxtPage[]) => void) => void) | undefined
  hookPages?.("pages:extend", (pages) => {
    const additions: NuxtPage[] = [
      { file: join(consoleRuntimeRoot, "pages/index.vue"), name: "vitehub-console", path: "/_vitehub" },
      { file: join(consoleRuntimeRoot, "pages/agents.vue"), name: "vitehub-console-agents", path: "/_vitehub/agents" },
      { file: join(consoleRuntimeRoot, "pages/agents.vue"), name: "vitehub-console-agent", path: "/_vitehub/agents/:agent" },
      { file: join(consoleRuntimeRoot, "pages/agents.vue"), name: "vitehub-console-invocation", path: "/_vitehub/agents/:agent/invocations/:invocation" },
    ]
    for (const page of additions) {
      if (!pages.some(candidate => candidate.path === page.path)) pages.push(page)
    }
  })

  const nitro = (nuxt.options.nitro ??= {}) as {
    handlers?: Array<{ handler: string, route: string }>
    plugins?: string[]
  }
  const handlers = (nitro.handlers ??= [])
  const additions = [
    { handler: join(consoleRuntimeRoot, "server/agents.get.js"), route: "/api/_vitehub/console/agents" },
    { handler: join(consoleRuntimeRoot, "server/invocations.get.js"), route: "/api/_vitehub/console/invocations" },
    { handler: join(consoleRuntimeRoot, "server/invocation.get.js"), route: "/api/_vitehub/console/invocations/:id" },
    { handler: join(consoleRuntimeRoot, "server/search.get.js"), route: "/api/_vitehub/console/search" },
  ]
  for (const handler of additions) {
    if (!handlers.some(candidate => candidate.route === handler.route)) handlers.push(handler)
  }
  const plugins = (nitro.plugins ??= [])
  const plugin = join(projectRoot, ".vitehub/nitro/console/plugin.mjs")
  const refreshAgentDefinitions = serializeConsoleRefresh(async () => {
    await writeConsoleNitroPlugin(
      plugin,
      projectRoot,
      discoverAgentDefinitionEntries(discoveryRoot, serverDirs),
    )
  })
  // Nitro runs in another runtime realm, so install a second journal instance over the same project SQLite file.
  await refreshAgentDefinitions()
  if (nuxt.options.dev) {
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Nuxt exposes hook overloads, while this structural seam keeps narrow test hosts assignable.
    // SAFETY: Nuxt's hook overload includes builder:watch with this callback contract.
    const hookBuilderWatch = nuxt.hook as unknown as ((name: "builder:watch", callback: () => Promise<void>) => void) | undefined
    hookBuilderWatch?.("builder:watch", refreshAgentDefinitions)
  }
  if (!plugins.includes(plugin)) plugins.push(plugin)
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

type VitePluginNitroModule = {
  name?: string
  setup: (nitro: unknown) => void | Promise<void>
}

function vitePluginNitroModule(plugin: Plugin): VitePluginNitroModule | undefined {
  const nitro = (plugin as Plugin & { nitro?: VitePluginNitroModule }).nitro
  return nitro && typeof nitro.setup === "function" ? nitro : undefined
}

function installVitePluginNitroModules(config: Record<string, unknown>, plugins: Plugin[]): void {
  const configured = config.modules
  const modules = Array.isArray(configured) ? configured : configured ? [configured] : []
  config.modules = modules
  for (const plugin of plugins) {
    const nitroModule = vitePluginNitroModule(plugin)
    if (!nitroModule) continue
    if (!modules.some((candidate) => {
      if (candidate === nitroModule) return true
      return Boolean(nitroModule.name && candidate && typeof candidate === "object" && Reflect.get(candidate, "name") === nitroModule.name)
    })) modules.push(nitroModule)
  }
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

async function applyNitroConfig(
  plugins: Plugin[],
  nitroConfig: Record<string, unknown>,
  nuxt: NuxtLike,
  projectRoot: string,
) {
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
    [VITEHUB_PROJECT_ROOT]?: string
    [VITEHUB_SERVER_DIRS]?: string[]
    nitro?: Record<string, unknown>
  }
  config.root = resolve(nuxt.options.rootDir || process.cwd(), config.root || ".")
  const restoreReplayOwnership = () => {
    config[VITEHUB_GENERATED_ROOT] = generatedRoot
    config[VITEHUB_NITRO_CONFIG_CONTEXT] = true
    config[VITEHUB_PROJECT_ROOT] = projectRoot
    if (serverDirs) config[VITEHUB_SERVER_DIRS] = serverDirs
  }
  restoreReplayOwnership()
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
      }
      restoreReplayOwnership()
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

  await finalizeNitroReplayPlugins(plugins, config)

  if (config.nitro) {
    installVitePluginNitroModules(config.nitro, plugins)
    Object.assign(nitroConfig, config.nitro)
  }
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
  nuxt.options.vite ??= {}
  nuxt.options.vite.root ??= rootDir
  const viteRoot = resolve(rootDir, typeof nuxt.options.vite?.root === "string" ? nuxt.options.vite.root : rootDir)
  const projectRoot = resolveViteHubProjectRoot(viteRoot)
  if (options.console) {
    const configuredConsole = options.console === true ? true : options.console
    const viteAuth = nuxt.options.vite?.auth
    const effectiveAuth = viteAuth ?? options.auth
    assertConsoleProductionAccess(configuredConsole, {
      auth: configuredConsole !== true && configuredConsole.access === "auth" && effectiveAuth
        ? resolveAuthViteConfig(
            effectiveAuth === true ? undefined : effectiveAuth,
            viteRoot,
            { serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined },
          )
        : undefined,
      development: Boolean(nuxt.options.dev),
      preset: plan.preset,
    })
    await installConsole(
      nuxt,
      projectRoot,
      viteRoot,
      nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
    )
  }
  const viteConfig = nuxt.options.vite as UserConfig & EnvViteUserConfig & {
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_PROJECT_ROOT]?: string
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
    .filter(plugin => !options.console || !["vite-hub/console", "vite-hub/console-invocation-root"].includes(plugin.name))
  const plugins = [
    ...installedPlugins.filter(plugin => plugin.name !== "vite-hub/deployment-output"),
    ...(options.console ? [consoleInvocationRootPlugin(projectRoot)] : []),
  ]
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
  const typesPlugin = replayPlugins.find(plugin => plugin.name === "vite-hub/types") as Plugin & {
    api?: {
      prepareTypes?: (options: {
        projectRoot: string
        serverDirs?: string[]
      }) => Promise<GeneratedServerHandler[]>
    }
  } | undefined
  const generatedHandlers = await typesPlugin?.api?.prepareTypes?.({
    projectRoot,
    serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
  }) ?? []

  viteConfig.define = {
    ...viteConfig.define,
    __VITEHUB_APP_BASE_URL__: JSON.stringify(nuxt.options.app?.baseURL || "/"),
  }
  viteConfig[VITEHUB_GENERATED_ROOT] = join(nuxt.options.buildDir, "vitehub")
  viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  viteConfig[VITEHUB_PROJECT_ROOT] = projectRoot
  if (nuxt.options.serverDir) viteConfig[VITEHUB_SERVER_DIRS] = [nuxt.options.serverDir]
  const installedVitePlugins: unknown = [
    ...plugins.filter(plugin => !existingNames.has(plugin.name)),
    ...existing,
  ]
  // SAFETY: Both arrays contain Vite plugins normalized or preserved by this integration.
  nuxt.options.vite.plugins = installedVitePlugins as PluginOption[]
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
    await applyNitroConfig(replayPlugins, config, nuxt, projectRoot)
    Object.assign(config, mergeGeneratedNitroConfig(config, generatedHandlers))
    installNitroRuntimeResolvers(config, replayPlugins)
    installMarkdownTemplateResolver(config, markdownTemplatePlugin)
    if (emailPlugin && nuxt.options.dev) {
      installEmailTemplateResolver(config, join(projectRoot, ".vitehub/email/templates"))
    }
    const alias = (config.alias ??= {}) as Record<string, string>
    for (const [name, path] of Object.entries(generatedAliases)) alias[name] ??= path
  })
  if (options.agent) addVueImports(nuxt, "vite-hub/agent/vue", agentVueComposables)
  addVueImports(nuxt, "vite-hub/source/client", ["useCollection"])
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
