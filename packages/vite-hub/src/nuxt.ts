import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveViteHubProjectRoot, VITEHUB_GENERATED_ROOT, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalizeNitroPreset, resolveDeploymentPlan } from "@vite-hub/internal/deployment"
import hubAuthNuxt from "@vite-hub/auth/nuxt"
import { resolveAuthViteConfig } from "@vite-hub/auth/vite"
import { resolveBlobViteConfig } from "@vite-hub/blob/vite"
import { hubDb as hubDatabaseNuxt } from "@vite-hub/database/nuxt"
import { resolveEmailTemplateModulePath } from "@vite-hub/email/vite"
import { createEnvImportAliases } from "@vite-hub/env/vite"
import { resolveKVViteConfig } from "@vite-hub/kv/vite"
import { mergeGeneratedSourceNitroConfig, type GeneratedSourceHandler } from "@vite-hub/source/vite"
import { mergeConfig } from "vite"

import { vitehub } from "./index.ts"
import { createConsoleCliNamespace } from "./console/cli.ts"
import { consoleFixtureEnvironmentVariable, consoleFixtureRevision, readConsoleFixture } from "./console/fixture.ts"
import { createConsoleInvocationsIdentity } from "./console/internal.ts"
import { installConsoleInvocations } from "./console/runtime/server/invocations.ts"
import { discoverConsoleBuildCatalog } from "./console/build.ts"
import { writeConsoleNitroPlugin } from "./console/plugin.ts"
import { installConsoleProjectName, installConsoleSections } from "./console/runtime/server/sections.ts"
import { resolveConsoleProjectNameFromRoot } from "./console/project.ts"
import { resolveConsoleSectionIds, type ConsoleSectionId } from "./console/runtime/sections.ts"
import { consoleDefinitionSectionIds } from "./console/runtime/definitions.ts"
import { addConsoleDevframeHandler } from "./console/nitro.ts"
import { serializeConsoleRefresh } from "./console/refresh.ts"
import { assertConsoleProductionAccess, closeConsoleInvocationRootState, configureConsoleFixtureLifecycle, consoleInvocationRootPlugin, createConsoleInvocationRootState, generatedConsolePluginRegistration, resolveGeneratedConsolePlugin, type ConsoleInvocationRootState, updateConsoleInvocationRootState } from "./console/vite.ts"

import type { AgentInvocationsOptions } from "@vite-hub/agent/server"
import type { DatabaseNuxtIntegrationOptions } from "@vite-hub/database"
import type { AuthModuleOptions } from "@vite-hub/auth"
import type { EnvIntegrationOptions, EnvViteConfigOptions, EnvViteUserConfig } from "@vite-hub/env"
import type { KVModuleOptions } from "@vite-hub/kv"
import type { QueueModuleOptions } from "@vite-hub/queue"
import type { HookHandler, Plugin, PluginOption, ResolvedConfig, UserConfig } from "vite"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"

const databaseRuntimeState = fileURLToPath(new URL("./_internal/database/runtime/state", import.meta.url))
const consoleRuntimeRoot = fileURLToPath(new URL("./console/runtime", import.meta.url))
type NuxtPage = { file: string, name: string, path: string }
type ViteHubNuxtOptions = Omit<Parameters<typeof vitehub>[0], "database" | "env"> & {
  database?: boolean | Exclude<DatabaseNuxtIntegrationOptions, false>
  env?: false | EnvIntegrationOptions & EnvViteConfigOptions
}

function configuredProjectRoot(root: string, value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Replayed Vite service configuration is an open integration boundary, so validate its runtime shape before reading the optional root.
  return value && typeof value === "object" && "projectRoot" in value && typeof value.projectRoot === "string"
    ? resolve(root, value.projectRoot)
    : undefined
}

function configuredProjectRootOption(value: unknown): string | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Replayed Vite service configuration is an open integration boundary, so validate its runtime shape before reading the optional root.
  return value && typeof value === "object" && "projectRoot" in value && typeof value.projectRoot === "string"
    ? value.projectRoot
    : undefined
}

function configuredScanDirs(value: unknown): string[] | undefined {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Replayed Vite service configuration is an open integration boundary, so validate its runtime shape before reading scan directories.
  return value && typeof value === "object" && "scanDirs" in value && Array.isArray(value.scanDirs)
    ? value.scanDirs.filter((entry): entry is string => typeof entry === "string")
    : undefined
}

type NuxtLike = {
  callHook?: (name: "restart") => Promise<void>
  hook?: (
    name: "close" | "nitro:config",
    callback: ((config: Record<string, unknown>) => Promise<void>) | (() => Promise<void>),
  ) => void
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
    routeRules?: Record<string, {
      headers?: Record<string, string>
      [key: string]: unknown
    }>
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: UserConfig & {
      auth?: AuthModuleOptions
      database?: Parameters<typeof vitehub>[0]["database"]
      kv?: KVModuleOptions
      queue?: QueueModuleOptions
      rateLimit?: Parameters<typeof vitehub>[0]["rateLimit"]
      schedule?: Parameters<typeof vitehub>[0]["schedule"]
      workspace?: Parameters<typeof vitehub>[0]["workspace"]
      workflow?: Parameters<typeof vitehub>[0]["workflow"]
    }
    vitehub?: ViteHubNuxtOptions
    vitehubCliDiscovery?: true
    watch?: string[]
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

function asReplayResolvedConfig(config: UserConfig): ResolvedConfig {
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: Nitro replay has applied every Vite config hook and normalized the fields used by ViteHub runtime owners.
  return config as unknown as ResolvedConfig
}

async function finalizeNitroReplayPlugins(plugins: Plugin[], config: UserConfig): Promise<void> {
  for (const plugin of plugins) {
    if (!nitroConfigResolvedNames.has(plugin.name)) continue
    const configResolved = pluginConfigResolvedHandler(plugin)
    if (!configResolved) continue
    // SAFETY: Rollup supplies an opaque plugin context; the replayed hook does not read it.
    await configResolved.call({} as never, asReplayResolvedConfig(config))
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

function configuredProjectRoots(options: Parameters<typeof vitehub>[0], rootDir: string, viteRoot: string): string[] {
  return Object.entries(options)
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
      throw viteHubErrorDiagnostics.VITE_HUB_B0008({ message: `[vitehub] Cannot auto-import ${name} from ${from} because it is already configured from ${existing.from}.` })
    }
    if (!existing) imports.push({ from, name })
  }
}

async function installConsole(
  nuxt: NuxtLike,
  projectRoot: string,
  discoveryRoot: string,
  workflowDiscoveryRoot: string,
  queueDiscoveryRoot: string,
  sections: readonly ConsoleSectionId[],
  blobStores: readonly string[],
  kvStores: readonly string[],
  fixture?: string,
  serverDirs?: string[],
  installInvocations = true,
  writeGeneratedPlugin = true,
  invoke = false,
  observations: AgentInvocationsOptions["observations"] = undefined,
  invocationRootState?: ConsoleInvocationRootState,
  canDiscoverDefinitions: () => boolean = () => true,
  discoveryOptions: Pick<Parameters<typeof discoverConsoleBuildCatalog>[0], "databaseDiscoveryRoot" | "rateLimitDiscoveryRoot" | "rateLimitScanDirs" | "scheduleDiscoveryRoot" | "workspaceDiscoveryRoot"> = {},
): Promise<string> {
  const uiModule = (await import("@vite-hub/ui/nuxt")).default
  const uiConfigured = (nuxt.options.modules ?? []).some((entry) => {
    const module = Array.isArray(entry) ? entry[0] : entry
    return module === "@vite-hub/ui/nuxt" || module === "vite-hub/ui/nuxt" || module === uiModule
  })
  if (!uiConfigured) {
    await Reflect.apply(uiModule, undefined, [{}, nuxt])
  }
  const plugin = resolveGeneratedConsolePlugin(projectRoot, fixture, invocationRootState)
  installConsoleSections(projectRoot, sections)
  installConsoleProjectName(projectRoot, resolveConsoleProjectNameFromRoot(projectRoot))
  if (installInvocations && nuxt.options.dev && sections.includes("agents") && !fixture) installConsoleInvocations(projectRoot, undefined, observations)
  const routeRules = (nuxt.options.routeRules ??= {})
  for (const route of ["/_vitehub", "/_vitehub/**"]) {
    const rule = (routeRules[route] ??= {})
    rule.headers = { ...rule.headers, "x-robots-tag": "noindex, nofollow" }
  }
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Nuxt exposes hook overloads, while this structural seam keeps narrow nitro-only test hosts assignable.
  const hookPages = nuxt.hook as unknown as ((name: "pages:extend", callback: (pages: NuxtPage[]) => void) => void) | undefined
  hookPages?.("pages:extend", (pages) => {
    const additions: NuxtPage[] = [
      {
        file: join(consoleRuntimeRoot, "pages/index.vue"),
        name: "vitehub-console",
        path: "/_vitehub",
      },
      ...(sections.includes("agents")
        ? [
            {
              file: join(consoleRuntimeRoot, "pages/agents.vue"),
              name: "vitehub-console-agents",
              path: "/_vitehub/agents",
            },
            {
              file: join(consoleRuntimeRoot, "pages/agents.vue"),
              name: "vitehub-console-agent",
              path: "/_vitehub/agents/:agent",
            },
            {
              file: join(consoleRuntimeRoot, "pages/agents.vue"),
              name: "vitehub-console-invocation",
              path: "/_vitehub/agents/:agent/invocations/:invocation",
            },
          ]
        : []),
      ...(sections.includes("usage")
        ? [{ file: join(consoleRuntimeRoot, "pages/agents.vue"), name: "vitehub-console-usage", path: "/_vitehub/usage" }]
        : []),
      ...(sections.includes("blob")
        ? [{
            file: join(consoleRuntimeRoot, "pages/blob.vue"),
            name: "vitehub-console-blob",
            path: "/_vitehub/blob",
          }]
        : []),
      ...(sections.includes("kv")
        ? [{
            file: join(consoleRuntimeRoot, "pages/kv.vue"),
            name: "vitehub-console-kv",
            path: "/_vitehub/kv",
          }]
        : []),
      ...(sections.includes("databases")
        ? [
            {
              file: join(consoleRuntimeRoot, "pages/databases.vue"),
              name: "vitehub-console-databases-schema",
              path: "/_vitehub/databases/:database/schema/diagram",
            },
            {
              file: join(consoleRuntimeRoot, "pages/databases.vue"),
              name: "vitehub-console-databases",
              path: "/_vitehub/databases/:database?/:table?",
            },
          ]
        : []),
      ...(sections.includes("workflows")
        ? [{
            file: join(consoleRuntimeRoot, "pages/workflows.vue"),
            name: "vitehub-console-workflows",
            path: "/_vitehub/workflows",
          }]
        : []),
      ...(sections.includes("workspaces")
        ? [{
            file: join(consoleRuntimeRoot, "pages/workspaces.vue"),
            name: "vitehub-console-workspaces",
            path: "/_vitehub/workspaces",
          }]
        : []),
      ...(sections.includes("sandboxes")
        ? [{
            file: join(consoleRuntimeRoot, "pages/sandboxes.vue"),
            name: "vitehub-console-sandboxes",
            path: "/_vitehub/sandboxes",
          }]
        : []),
      ...(sections.includes("rate-limits")
        ? [{
            file: join(consoleRuntimeRoot, "pages/rate-limits.vue"),
            name: "vitehub-console-rate-limits",
            path: "/_vitehub/rate-limits",
          }]
        : []),
      ...(sections.includes("queues")
        ? [{
            file: join(consoleRuntimeRoot, "pages/queues.vue"),
            name: "vitehub-console-queues",
            path: "/_vitehub/queues",
          }]
        : []),
      ...(sections.includes("schedules")
        ? [{
            file: join(consoleRuntimeRoot, "pages/schedules.vue"),
            name: "vitehub-console-schedules",
            path: "/_vitehub/schedules",
          }]
        : []),
    ]
    for (const page of additions) {
      if (!pages.some((candidate) => candidate.path === page.path)) pages.push(page)
    }
  })

  const nitro = (nuxt.options.nitro ??= {}) as {
    handlers?: Array<{ handler: string, route: string }>
    plugins?: string[]
  }
  addConsoleDevframeHandler(nitro, consoleRuntimeRoot)
  const plugins = (nitro.plugins ??= []).filter(candidate => !generatedConsolePluginRegistration(candidate))
  nitro.plugins = plugins
  const refreshAgentDefinitions = serializeConsoleRefresh(async () => {
    const discoverySections = canDiscoverDefinitions()
      ? sections
      : sections.filter(section => !consoleDefinitionSectionIds.some(definitionSection => definitionSection === section))
    const catalog = await discoverConsoleBuildCatalog({
      ...discoveryOptions,
      discoveryRoot,
      projectRoot,
      queueDiscoveryRoot,
      sections: discoverySections,
      serverDirs,
      workflowDiscoveryRoot,
    })
    const identity = await writeConsoleNitroPlugin(
      plugin,
      projectRoot,
      sections,
      catalog.agents,
      catalog,
      blobStores,
      kvStores,
      fixture,
      invocationRootState?.binding,
      invoke,
      observations,
      () => !invocationRootState?.closed,
    )
    if (invocationRootState) {
      updateConsoleInvocationRootState(invocationRootState, projectRoot, identity)
    }
  })
  if (fixture && invocationRootState) {
    configureConsoleFixtureLifecycle(invocationRootState, plugin, refreshAgentDefinitions)
    // Nuxt closes after Vite startup failures that happen before buildStart can own this fixture binding.
    nuxt.hook?.("close", async () => closeConsoleInvocationRootState(invocationRootState))
  }
  if (writeGeneratedPlugin) await refreshAgentDefinitions()
  if (nuxt.options.dev && writeGeneratedPlugin) {
    if (fixture) {
      nuxt.options.watch = [...new Set([...(nuxt.options.watch ?? []), fixture])]
    }
    // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- Nuxt exposes hook overloads, while this structural seam keeps narrow test hosts assignable.
    // SAFETY: Nuxt's hook overload includes builder:watch with this callback contract.
    const hookBuilderWatch = nuxt.hook as unknown as ((name: "builder:watch", callback: (event: string, path: string) => Promise<void>) => void) | undefined
    hookBuilderWatch?.("builder:watch", async (_event, _path) => {
      if (fixture) {
        await refreshAgentDefinitions().catch((error) => {
          console.error(`[vitehub] Could not refresh Console development state: ${error instanceof Error ? error.message : String(error)}`)
        })
        return
      }
      await refreshAgentDefinitions()
    })
  }
  if (!plugins.includes(plugin)) plugins.push(plugin)
  return plugin
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

function filterPluginOptions(
  options: readonly unknown[],
  keep: (plugin: Plugin) => boolean,
): unknown[] {
  return options.flatMap((option) => {
    if (Array.isArray(option)) {
      const nested = filterPluginOptions(option, keep)
      return nested.length > 0 ? [nested] : []
    }
    const plugin = flattenPlugins([option])[0]
    if (plugin && !keep(plugin)) return []
    return [option]
  })
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
    blob?: Parameters<typeof vitehub>[0]["blob"]
    database?: Parameters<typeof vitehub>[0]["database"]
    queue?: QueueModuleOptions
    rateLimit?: Parameters<typeof vitehub>[0]["rateLimit"]
    schedule?: Parameters<typeof vitehub>[0]["schedule"]
    sandbox?: Parameters<typeof vitehub>[0]["sandbox"]
    workspace?: Parameters<typeof vitehub>[0]["workspace"]
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
  let replayedDatabaseDiscoveryRoot: string | undefined
  let hasReplayedDatabaseDiscoveryRoot = false
  for (const plugin of orderedPlugins) {
    const handler = configHandler(plugin)
    if (handler) {
      const previousDatabaseProjectRoot = configuredProjectRootOption(config.database)
      const result = await handler.call({} as never, config, environment)
      let returnedDatabase: Parameters<typeof vitehub>[0]["database"] | undefined
      if (result) {
        // SAFETY: Vite config hooks return Vite's UserConfig shape extended by ViteHub's documented service keys.
        const { nitro, ...viteConfig } = result as UserConfig & {
          database?: Parameters<typeof vitehub>[0]["database"]
          nitro?: Record<string, unknown>
        }
        if (Object.hasOwn(viteConfig, "database")) returnedDatabase = viteConfig.database
        config = mergeConfig(config, viteConfig)
        // SAFETY: The ViteHub replay boundary accepts Nitro's open configuration object under the `nitro` key.
        if (nitro) config.nitro = nitro as Record<string, unknown>
      }
      if (plugin.name !== "@vite-hub/database/vite") {
        const currentDatabaseProjectRoot = configuredProjectRootOption(config.database)
        if (returnedDatabase !== undefined || currentDatabaseProjectRoot !== previousDatabaseProjectRoot) {
          hasReplayedDatabaseDiscoveryRoot = true
          replayedDatabaseDiscoveryRoot = returnedDatabase !== undefined
            ? configuredProjectRoot(config.root || projectRoot, returnedDatabase)
            : configuredProjectRoot(config.root || projectRoot, config.database)
        }
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
  return { config, hasReplayedDatabaseDiscoveryRoot, replayedDatabaseDiscoveryRoot }
}

function resolvedKVFromPlugin(plugin: Plugin | undefined, configured: KVModuleOptions | undefined): ReturnType<typeof resolveKVViteConfig>["kv"] {
  const candidate: unknown = plugin
  // SAFETY: The canonical KV plugin name identifies the framework-owned configuration API.
  const kvPlugin = candidate as (Plugin & {
    api?: { getConfig?: () => ReturnType<typeof resolveKVViteConfig> }
  }) | undefined
  return kvPlugin?.api?.getConfig?.().kv ?? (configured === undefined ? false : resolveKVViteConfig(configured).kv)
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
    throw viteHubErrorDiagnostics.VITE_HUB_B0009({ message: "[vitehub] vitehub preset " + JSON.stringify(plan.preset) + " conflicts with nitro.preset " + JSON.stringify(nitro.preset) + "." })
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
  const projectRoot = resolveViteHubProjectRoot(rootDir)
  const configuredDatabaseDiscoveryRoot = configuredProjectRoot(viteRoot, nuxt.options.vite?.database)
    ?? configuredProjectRoot(rootDir, options.database)
  // SAFETY: ViteHub Blob extends Vite's open user config with the documented top-level `blob` key.
  const viteBlob = (nuxt.options.vite as UserConfig & { blob?: Parameters<typeof vitehub>[0]["blob"] }).blob
  const effectiveBlob = options.console ? viteBlob ?? options.blob : false
  const explicitBlob = Boolean(effectiveBlob && effectiveBlob !== true && ("driver" in effectiveBlob || "stores" in effectiveBlob))
  const consoleBlobEnabled = Boolean(effectiveBlob) && (plan.services.blob.supported || explicitBlob)
  const resolvedConsoleBlob = consoleBlobEnabled
    ? resolveBlobViteConfig(effectiveBlob === true ? undefined : effectiveBlob, { hosting: plan.nitroPreset }).blob
    : false
  const consoleBlobStores = resolvedConsoleBlob
    ? Object.keys(resolvedConsoleBlob.stores || { default: resolvedConsoleBlob.store })
    : []
  const effectiveKV = nuxt.options.vite?.kv ?? options.kv
  const effectiveQueue = nuxt.options.vite?.queue ?? options.queue
  const effectiveWorkflow = nuxt.options.vite?.workflow ?? options.workflow
  const consoleSections = resolveConsoleSectionIds({
    ...options,
    blob: consoleBlobEnabled,
    kv: effectiveKV,
    preset: plan.preset,
    queue: effectiveQueue,
    sandbox: options.sandbox === true && plan.services.sandbox.supported,
    workflow: effectiveWorkflow,
  })
  const configuredConsoleKV = effectiveKV && effectiveKV !== true ? effectiveKV : undefined
  const resolvedConsoleKV = effectiveKV
    ? resolveKVViteConfig(configuredConsoleKV, { hosting: plan.nitroPreset }).kv
    : false
  const consoleKVStores = resolvedConsoleKV
    ? Object.keys(resolvedConsoleKV.stores || { default: resolvedConsoleKV.store })
    : []
  const consoleInvocationRootState = createConsoleInvocationRootState()
  const consoleInvokeEnabled = options.console === true
    || (options.console !== false && options.console?.invoke === true)
  let resolvedConsoleFixture: string | undefined
  let generatedConsolePluginPath: string | undefined
  let consoleWorkflowConfigResolved = false
  if (options.console) {
    const configuredConsole = options.console === true ? true : options.console
    const viteAuth = nuxt.options.vite?.auth
    const effectiveAuth = viteAuth ?? options.auth
    if (!nuxt.options.vitehubCliDiscovery) {
      assertConsoleProductionAccess(configuredConsole, {
        auth: configuredConsole !== true && configuredConsole.access === "auth" && effectiveAuth
          ? resolveAuthViteConfig(
              effectiveAuth === true ? undefined : effectiveAuth,
              viteRoot,
              { serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined },
            )
          : undefined,
        development: Boolean(nuxt.options.dev),
      })
    }
    const fixture = nuxt.options.vitehubCliDiscovery
      ? undefined
      : process.env[consoleFixtureEnvironmentVariable]
    if (fixture && !nuxt.options.dev) throw viteHubErrorDiagnostics.VITE_HUB_B0010({ message: "[vitehub] Console fixture mode is development-only." })
    resolvedConsoleFixture = fixture ? resolve(projectRoot, fixture) : undefined
    if (resolvedConsoleFixture) readConsoleFixture(resolvedConsoleFixture)
  }
  const viteConfig = nuxt.options.vite as UserConfig & EnvViteUserConfig & {
    [VITEHUB_GENERATED_ROOT]?: string
    [VITEHUB_NITRO_CONFIG_CONTEXT]?: true
    [VITEHUB_PROJECT_ROOT]?: string
    [VITEHUB_SERVER_DIRS]?: string[]
    kv?: KVModuleOptions
    queue?: QueueModuleOptions
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
    ...(effectiveQueue ? [relative(nuxt.options.buildDir, join(projectRoot, ".vitehub/queue.d.ts"))] : []),
    ...(options.schedule ? [relative(nuxt.options.buildDir, join(projectRoot, ".vitehub/schedule.d.ts"))] : []),
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
  const consoleFixtureSnapshot = resolvedConsoleFixture ? readConsoleFixture(resolvedConsoleFixture) : undefined
  const plugins = [
    ...installedPlugins.filter(plugin => plugin.name !== "vite-hub/deployment-output"),
    ...(options.console
      ? [{
          name: "vite-hub/console-cli",
          vitehub: { cli: { namespaces: [createConsoleCliNamespace()] } },
        }]
      : []),
    ...(options.console && options.agent ? [consoleInvocationRootPlugin(
      projectRoot,
      createConsoleInvocationsIdentity(
        projectRoot,
        resolvedConsoleFixture,
        consoleFixtureSnapshot ? consoleFixtureRevision(consoleFixtureSnapshot) : undefined,
        consoleInvocationRootState.binding,
      ),
      consoleInvocationRootState,
    )] : []),
  ]
  const existing = withoutDeploymentOutput(
    Array.isArray(nuxt.options.vite?.plugins) ? nuxt.options.vite.plugins : [],
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
  const retainedKVPlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/kv/vite")
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
  // SAFETY: The plugin name identifies the ViteHub Source plugin and its public preparation API.
  const sourcePlugin = replayPlugins.find(plugin => plugin.name === "@vite-hub/source/vite") as Plugin & {
    api?: {
      onGeneratedHandlersChanged?: (
        listener: (handlers: GeneratedSourceHandler[]) => Promise<void> | void,
        options?: { handlesHostRestart?: boolean, projectRoot?: string },
      ) => () => void
      prepareSources?: (options: {
        projectRoot: string
        serverDirs?: string[]
      }) => Promise<GeneratedSourceHandler[]>
    }
  } | undefined
  let generatedSourceHandlers = await sourcePlugin?.api?.prepareSources?.({
    projectRoot,
    serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
  }) ?? []
  const typesPlugin = replayPlugins.find(plugin => plugin.name === "vite-hub/types") as Plugin & {
    api?: {
      prepareTypes?: (options: { projectRoot: string }) => Promise<void>
      setPrepareSources?: (prepareSources: ((options: {
        projectRoot: string
        serverDirs?: string[]
      }) => Promise<GeneratedSourceHandler[]>) | undefined) => void
    }
  } | undefined
  let generatedSourceRestart = Promise.resolve()
  let generatedSourceRestartClosed = false
  const removeGeneratedHandlersListener = sourcePlugin?.api?.onGeneratedHandlersChanged?.((handlers: GeneratedSourceHandler[]) => {
    const restart = generatedSourceRestart.then(async () => {
      if (generatedSourceRestartClosed) return
      const previousHandlers = generatedSourceHandlers
      generatedSourceHandlers = handlers
      try {
        await typesPlugin?.api?.prepareTypes?.({ projectRoot })
        if (generatedSourceRestartClosed) return
        await nuxt.callHook?.("restart")
      }
      catch (error) {
        generatedSourceHandlers = previousHandlers
        throw error
      }
    })
    generatedSourceRestart = restart.catch(() => {})
    return restart
  }, { handlesHostRestart: true, projectRoot })
  if (removeGeneratedHandlersListener) {
    nuxt.hook?.("close", async () => {
      generatedSourceRestartClosed = true
      removeGeneratedHandlersListener()
    })
  }
  typesPlugin?.api?.setPrepareSources?.(sourcePlugin?.api?.prepareSources)
  await typesPlugin?.api?.prepareTypes?.({ projectRoot })

  viteConfig.define = {
    ...viteConfig.define,
    __VITEHUB_APP_BASE_URL__: JSON.stringify(nuxt.options.app?.baseURL || "/"),
  }
  viteConfig[VITEHUB_GENERATED_ROOT] = join(nuxt.options.buildDir, "vitehub")
  viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT] = true
  viteConfig[VITEHUB_PROJECT_ROOT] = projectRoot
  if (nuxt.options.serverDir) viteConfig[VITEHUB_SERVER_DIRS] = [nuxt.options.serverDir]
  const installedVitePlugins: unknown = [
    ...plugins.map(plugin => existingPluginsByName.get(plugin.name) || plugin),
    ...filterPluginOptions(existing, plugin => !plugins.some(candidate => candidate.name === plugin.name)),
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
      throw viteHubErrorDiagnostics.VITE_HUB_B0011({ message: `[vitehub] Env projectRoot ${JSON.stringify(configuredEnvProjectRootOption)} conflicts with the installed Env Vite plugin.` })
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
    const {
      config: replayConfig,
      hasReplayedDatabaseDiscoveryRoot,
      replayedDatabaseDiscoveryRoot,
    } = await applyNitroConfig(replayPlugins, config, nuxt, projectRoot)
    consoleWorkflowConfigResolved = true
    if (options.console) {
      const resolvedKV = resolvedKVFromPlugin(retainedKVPlugin, viteConfig.kv)
      const replayedBlob = replayConfig.blob ?? effectiveBlob
      const replayedExplicitBlob = Boolean(replayedBlob && replayedBlob !== true && ("driver" in replayedBlob || "stores" in replayedBlob))
      const replayedBlobEnabled = Boolean(replayedBlob) && (plan.services.blob.supported || replayedExplicitBlob)
      const resolvedReplayedBlob = replayedBlobEnabled
        ? resolveBlobViteConfig(replayedBlob === true ? undefined : replayedBlob, { hosting: plan.nitroPreset }).blob
        : false
      const resolvedSections = resolveConsoleSectionIds({
        ...options,
        blob: replayedBlobEnabled,
        database: replayConfig.database ?? options.database,
        kv: resolvedKV,
        preset: plan.preset,
        queue: effectiveQueue === false
          ? false
          : effectiveQueue === undefined
            ? undefined
            : replayConfig.queue ?? effectiveQueue,
        sandbox: Boolean(replayConfig.sandbox ?? options.sandbox) && plan.services.sandbox.supported,
        workspace: replayConfig.workspace ?? options.workspace,
        workflow: replayConfig.workflow ?? options.workflow,
      })
      consoleSections.splice(0, consoleSections.length, ...resolvedSections)
      consoleBlobStores.splice(
        0,
        consoleBlobStores.length,
        ...(resolvedReplayedBlob ? Object.keys(resolvedReplayedBlob.stores || { default: resolvedReplayedBlob.store }) : []),
      )
      consoleKVStores.splice(
        0,
        consoleKVStores.length,
        ...(resolvedKV ? Object.keys(resolvedKV.stores || { default: resolvedKV.store }) : []),
      )
      installConsoleSections(projectRoot, consoleSections)
      installConsoleProjectName(projectRoot, resolveConsoleProjectNameFromRoot(projectRoot))
      addConsoleDevframeHandler(config, consoleRuntimeRoot)
      const consoleCatalog = await discoverConsoleBuildCatalog({
        databaseDiscoveryRoot: hasReplayedDatabaseDiscoveryRoot
          ? replayedDatabaseDiscoveryRoot
          : configuredDatabaseDiscoveryRoot,
        discoveryRoot: viteRoot,
        projectRoot,
        queueDiscoveryRoot: rootDir,
        rateLimitDiscoveryRoot: configuredProjectRoot(viteRoot, replayConfig.rateLimit ?? nuxt.options.vite?.rateLimit ?? options.rateLimit),
        rateLimitScanDirs: configuredScanDirs(replayConfig.rateLimit ?? nuxt.options.vite?.rateLimit ?? options.rateLimit),
        sections: consoleSections,
        scheduleDiscoveryRoot: configuredProjectRoot(viteRoot, options.schedule),
        serverDirs: nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
        workspaceDiscoveryRoot: configuredProjectRoot(viteRoot, replayConfig.workspace ?? nuxt.options.vite?.workspace ?? options.workspace),
        workflowDiscoveryRoot: rootDir,
      })
      await writeConsoleNitroPlugin(
        generatedConsolePluginPath ?? resolveGeneratedConsolePlugin(projectRoot, resolvedConsoleFixture, consoleInvocationRootState),
        projectRoot,
        consoleSections,
        consoleCatalog.agents,
        consoleCatalog,
        consoleBlobStores,
        consoleKVStores,
        resolvedConsoleFixture,
        consoleInvocationRootState.binding,
        consoleInvokeEnabled && !resolvedConsoleFixture,
        options.console === true ? undefined : options.console.observations,
        () => !consoleInvocationRootState.closed,
      )
    }
    Object.assign(config, mergeGeneratedSourceNitroConfig(config, generatedSourceHandlers))
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
  if (options.console) {
    generatedConsolePluginPath = await installConsole(
      nuxt,
      projectRoot,
      viteRoot,
      rootDir,
      rootDir,
      consoleSections,
      consoleBlobStores,
      consoleKVStores,
      resolvedConsoleFixture,
      nuxt.options.serverDir ? [nuxt.options.serverDir] : undefined,
      !nuxt.options.vitehubCliDiscovery,
      !nuxt.options.vitehubCliDiscovery,
      consoleInvokeEnabled && !resolvedConsoleFixture,
      options.console === true ? undefined : options.console.observations,
      consoleInvocationRootState,
      () => consoleWorkflowConfigResolved,
      {
        databaseDiscoveryRoot: configuredDatabaseDiscoveryRoot,
        rateLimitDiscoveryRoot: configuredProjectRoot(viteRoot, nuxt.options.vite.rateLimit ?? options.rateLimit),
        rateLimitScanDirs: configuredScanDirs(nuxt.options.vite.rateLimit ?? options.rateLimit),
        scheduleDiscoveryRoot: configuredProjectRoot(viteRoot, options.schedule),
        workspaceDiscoveryRoot: configuredProjectRoot(viteRoot, nuxt.options.vite.workspace ?? options.workspace),
      },
    )
  }
}

viteHubNuxtModule.getMeta = () => ({
  configKey: "vitehub",
  name: "vite-hub/nuxt",
})

export default viteHubNuxtModule
