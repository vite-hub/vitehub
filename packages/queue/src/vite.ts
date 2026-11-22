import { durabilityModuleFile } from "@vite-hub/internal/durability"
import { ownModule } from "@vite-hub/internal/build/paths"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, getDeploymentHost, getResolvedFeatureOptions, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit, mergeNitroExternal } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider, resolveHost, resolveHostPreset } from "@vite-hub/internal/hosting"
import { cloneRecord as cloneNitroConfig } from "@vite-hub/internal/object"
import { resolve } from "pathe"

import { normalizeQueueOptions } from "./config.ts"
import { collectQueueContributions } from "./contributions.ts"
import { queueDeploymentEnv } from "./deployment-env.ts"
import { discoverQueueDefinitions } from "./discovery.ts"
import { createCloudflareQueueBindings, createVercelQueueConsumerRoutes, generatedQueueNitroMiddleware, generatedQueueNitroPlugin, generatedQueueNitroVercelConsumerDir, generatedQueueTestSetup, queuePackageName, writeQueueNitroIntegration } from "./internal/vite-build.ts"
import type { NormalizedQueueOptions } from "./internal/vite-build.ts"
import { inspectQueueDefinitions, inspectQueueResources } from "./inspect.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { CollectedQueueContribution } from "./contributions.ts"
import type { DiscoveredQueueDefinition, QueueOptions } from "./types.ts"
import type { DeploymentEnvContribution } from "@vite-hub/internal/build/deployment-plan-output"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { ViteHubHost } from "@vite-hub/internal/deployment"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin, PluginOption, ResolvedConfig, UserConfig } from "vite"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

const operationsModule = ownModule(import.meta.url, "operations")

export { collectQueueContributions } from "./contributions.ts"
export type {
  CollectedQueueContribution,
  QueueContributingPlugin,
  QueueContribution,
  QueueContributionContext,
  QueueContributionFactory,
} from "./contributions.ts"
export { contributedQueueSource, discoverQueueDefinitions } from "./discovery.ts"
export { inspectQueueDefinitions, type QueueInspectionOptions, queueConsoleSection } from "./inspect.ts"

interface QueueProvisionContributingPlugin {
  vitehub?: {
    cli?: () => Promise<ViteHubCliContributor>
    durability?: DurabilityPluginMetadata["durability"]
    inspect?: () => ViteHubInspectionContributor | undefined
    operations?: readonly OperationContributionEntry[]
    queue?: {
      createNitroConfig: (options: QueueNitroConfigOptions) => Promise<Record<string, unknown>>
    }
  }
}
export type QueueVitePlugin = Plugin & QueueProvisionContributingPlugin & {
  /** The variables that Queue reads on the deployed host. See `queueDeploymentEnv()`. */
  api: { deploymentEnv: DeploymentEnvContribution }
}

export interface QueueNitroConfigOptions {
  development?: boolean
  nitro: Record<string, unknown>
  projectRoot: string
  root: string
  serverDirs?: string[]
  /**
   * The Vite config that a framework replays to make its Nitro config.
   * Queue reads `queue` from it and adds its Cloudflare entries to the provider output of this config, so the final Nitro config keeps them.
   */
  viteConfig?: UserConfig
}

/** Options that a framework distribution passes to `hubQueue()`. */
export interface QueueVitePluginInternalOptions {
  /** Module that exports the app's `databases`, for the postgres driver. Defaults to `@vite-hub/database/drizzle`. */
  databaseImport?: string
  /** Module that the generated Queue types augment, for example `vite-hub/queue`. Defaults to `@vite-hub/queue`. */
  importBase?: string
}

const mergeNoExternal = createNoExternalAddition(queuePackageName)
const databaseVitePluginName = "@vite-hub/database/vite"

interface DatabaseVitePlugin {
  api?: { getConfig?: () => { databases: Record<string, { dialect?: string } | undefined> } | undefined }
}

function findDatabasePlugin(plugins: readonly PluginOption[] | undefined): DatabaseVitePlugin | undefined {
  for (const plugin of plugins ?? []) {
    if (Array.isArray(plugin)) {
      const found = findDatabasePlugin(plugin)
      if (found) return found
    }
    // SAFETY: The plugin name identifies the Database integration, whose `api` has this shape.
    else if (plugin && typeof plugin === "object" && "name" in plugin && plugin.name === databaseVitePluginName) return plugin as DatabaseVitePlugin
  }
  return undefined
}

function hasPostgresDefaultDatabase(plugin: DatabaseVitePlugin | undefined): boolean {
  return plugin?.api?.getConfig?.()?.databases.default?.dialect === "postgresql"
}

export async function createQueueNitroConfig(plugin: QueueVitePlugin, options: QueueNitroConfigOptions): Promise<Record<string, unknown>> {
  const createNitroConfig = plugin.vitehub?.queue?.createNitroConfig
  if (!createNitroConfig) {
    throw queueErrorDiagnostics.QUEUE_PLUGIN_INCOMPATIBLE()
  }
  return createNitroConfig(options)
}

function resolveStableQueueDefinitions(resolveDefinitions: () => DiscoveredQueueDefinition[], snapshot: DiscoveredQueueDefinition[], context: string) {
  const definitions = resolveDefinitions()
  if (JSON.stringify(definitions) !== JSON.stringify(snapshot)) {
    throw queueErrorDiagnostics.QUEUE_DEFINITIONS_CHANGED({ context })
  }
  return definitions
}

function normalizeQueueForHosting(queue: QueueOptions | undefined, hosting: string | undefined) {
  if (queue && typeof queue === "object" && Object.hasOwn(queue, "driver")) {
    const driver = (queue as Record<string, unknown>).driver
    const driverOnly = normalizeQueueOptions({ driver } as QueueOptions, { hosting })
    if (driverOnly?.driver && hosting && driverOnly.driver !== hosting) return undefined
  }
  return normalizeQueueOptions(queue, { hosting })
}

function frameworkProjectRoot(config: object): string | undefined {
  const configured: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
  return typeof configured === "string" && configured ? resolve(configured) : undefined
}

function resolveQueueHost(config: object, nitro: Record<string, unknown>): ViteHubHost | undefined {
  return resolveHost({ nitro, hosting: getDeploymentHost(config) })
}

function resolveQueueHosting(queue: QueueOptions | undefined, host: ViteHubHost | undefined, postgresDatabase = false): string {
  const hosting = getHostingProvider(host)
  if (hosting) return hosting
  if (host === "node") return normalizeQueueOptions(queue, { hosting: "node-server", postgresDatabase })?.driver ?? "local"
  return normalizeQueueForHosting(queue, hosting)?.driver || "vercel"
}

function supportsCloudflareQueues(nitro: Record<string, unknown>): boolean {
  return !(resolveHostPreset({ nitro }) ?? "").replaceAll("-", "_").includes("cloudflare_pages")
}

function isGeneratedNitroRegistration(value: unknown, generatedPath: string): boolean {
  return typeof value === "string"
    && (value === generatedPath || value.replaceAll("\\", "/").endsWith(`/${generatedPath}`))
}

function isGeneratedVercelConsumer(value: unknown): boolean {
  return typeof value === "string" && value.replaceAll("\\", "/").includes(`${generatedQueueNitroVercelConsumerDir}/`)
}

function hostsVercelQueueConsumers(nitro: Record<string, unknown>): boolean {
  const hosting = getHostingProvider(resolveHost({ nitro }))
  return hosting === "vercel" || (hosting === undefined && Boolean(process.env.VERCEL))
}

function addVercelQueueConsumers(kit: ReturnType<typeof createNitroServerKit>, definitions: DiscoveredQueueDefinition[], root: string | undefined) {
  const vercel = cloneNitroConfig(kit.config.vercel)
  const functionRules = cloneNitroConfig(vercel.functionRules)
  for (const consumer of createVercelQueueConsumerRoutes(definitions)) {
    kit.addHandler({ handler: root ? resolve(root, consumer.handler) : consumer.handler, route: consumer.route })
    functionRules[consumer.route] = {
      ...cloneNitroConfig(functionRules[consumer.route]),
      experimentalTriggers: [{ consumer: consumer.consumer, topic: consumer.topic, type: "queue/v2beta" }],
    }
  }
  kit.config.vercel = { ...vercel, functionRules }
}

function mergeNitroConfig(config: object, value: unknown, queue: QueueOptions | undefined, root: string, definitions: DiscoveredQueueDefinition[]): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const nitroHosting = getHostingProvider(resolveHost({ nitro }))
  const normalizedQueue = normalizeQueueForHosting(queue, nitroHosting)
  const providerMismatch = queue !== false && nitroHosting && queue && normalizedQueue === undefined
  const runtimeEnabled = queue !== false && !providerMismatch
  const nitroOwnsPaths = hasNitroConfigContext(config)
  const plugin = nitroOwnsPaths ? resolve(root, generatedQueueNitroPlugin) : generatedQueueNitroPlugin
  const middleware = nitroOwnsPaths ? resolve(root, generatedQueueNitroMiddleware) : generatedQueueNitroMiddleware
  nitro.plugins = Array.isArray(nitro.plugins)
    ? nitro.plugins.filter(entry => !isGeneratedNitroRegistration(entry, generatedQueueNitroPlugin))
    : []
  nitro.handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler => !isGeneratedNitroRegistration(handler?.handler, generatedQueueNitroMiddleware) && !isGeneratedVercelConsumer(handler?.handler))
    : []
  const kit = createNitroServerKit(nitro)
  if (!runtimeEnabled) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, kit.config, value)
  }
  kit.addPlugin(plugin, "start")
  kit.addHandler({ handler: middleware, middleware: true, route: "/**" }, "start")
  const queueHosting = resolveQueueHosting(queue, resolveQueueHost(config, nitro))
  const resolvedVercelQueue = queueHosting === "vercel" ? normalizeQueueOptions(queue, { hosting: queueHosting }) : undefined
  if (resolvedVercelQueue && resolvedVercelQueue.driver === "vercel" && hostsVercelQueueConsumers(nitro)) {
    addVercelQueueConsumers(kit, definitions, nitroOwnsPaths ? root : undefined)
  }
  if (queueHosting !== "cloudflare") {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, kit.config, value)
  }
  const cloudflare = cloneNitroConfig(nitro.cloudflare)
  const wrangler = cloneNitroConfig(cloudflare.wrangler)
  const compatibilityFlags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
  if (!compatibilityFlags.includes("nodejs_compat")) compatibilityFlags.push("nodejs_compat")
  const cloudflareQueues = supportsCloudflareQueues(nitro)
  const rollupConfig = cloneNitroConfig(nitro.rollupConfig)
  const resolvedQueue = normalizeQueueOptions(queue, { hosting: queueHosting })
  const generated = createCloudflareQueueBindings(definitions, resolvedQueue?.driver === "cloudflare" ? resolvedQueue.namePrefix : undefined)
  const baseNitro = {
    ...nitro,
    ...(cloudflareQueues ? { rollupConfig: { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") } } : {}),
    cloudflare: { ...cloudflare, wrangler: { ...wrangler, compatibility_flags: compatibilityFlags } },
    handlers: kit.config.handlers,
    plugins: kit.config.plugins,
  }
  if (!generated) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, value)
  }
  const binding = resolvedQueue?.driver === "cloudflare" && typeof resolvedQueue.binding === "string" ? resolvedQueue.binding : undefined
  if (binding && generated.producers.length > 1) {
    throw queueErrorDiagnostics.QUEUE_BINDING_CONFLICT()
  }
  const generatedProducers = binding ? generated.producers.map(producer => ({ ...producer, binding })) : generated.producers
  contributeCloudflareProviderOutput(providerOutput, {
    owner: "queue",
    queues: {
      ...(cloudflareQueues ? { consumers: generated.consumers } : {}),
      producers: generatedProducers,
    },
  })
  return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, value)
}

export function hubQueue(options?: QueueOptions, internalOptions: QueueVitePluginInternalOptions = {}): QueueVitePlugin {
  let resolved: ResolvedConfig | undefined
  let queue: QueueOptions | undefined = options
  let hosting = "vercel"
  let cloudflareQueues = true
  let configuredDefinitions: DiscoveredQueueDefinition[] = []
  let contributions: CollectedQueueContribution[] = []
  let localDevelopment = false
  let preview = false
  let nitroQueue: QueueOptions | undefined = queue
  let writtenQueue: NormalizedQueueOptions | undefined
  let nuxtConfiguredDefinitions: DiscoveredQueueDefinition[] | undefined
  let nuxtProjectRoot: string | undefined
  let resolveNuxtDefinitions: (() => DiscoveredQueueDefinition[]) | undefined
  let nuxtServerQueueDirs: string[] = []
  const resolvedConfigs = new Map<string, ResolvedConfig>()
  const queueOptions = new Map<string, QueueOptions | undefined>()
  const nuxtStates = new Map<string, {
    nuxtConfiguredDefinitions: DiscoveredQueueDefinition[]
    nuxtProjectRoot: string
    resolveNuxtDefinitions: () => DiscoveredQueueDefinition[]
  }>()
  const buildStates = new WeakMap<ResolvedConfig, {
    configuredDefinitions: DiscoveredQueueDefinition[]
    contributions: CollectedQueueContribution[]
    nuxtConfiguredDefinitions: DiscoveredQueueDefinition[] | undefined
    queue: QueueOptions | undefined
    resolveDefinitions: () => DiscoveredQueueDefinition[]
    resolveNuxtDefinitions: (() => DiscoveredQueueDefinition[]) | undefined
    resolved: ResolvedConfig
    validatesNitroDefinitions: boolean
  }>()
  let validatesNitroDefinitions = false
  let serverDirs: string[] | undefined
  async function collectPluginQueueContributions(plugins: readonly unknown[] | undefined, root: string, projectRoot = resolveViteHubProjectRoot(root), dirs = serverDirs) {
    return await collectQueueContributions(plugins, { projectRoot, root, serverDirs: dirs })
  }
  function discoverViteQueueDefinitions(viteRoot: string, outputRoot: string, found: CollectedQueueContribution[]): DiscoveredQueueDefinition[] {
    return resolve(viteRoot) === outputRoot
      ? discoverQueueDefinitions({ contributions: found, rootDir: viteRoot })
      : discoverQueueDefinitions({ contributions: found, rootDir: outputRoot, serverDirs })
  }
  function discoverCurrentQueueDefinitions(): DiscoveredQueueDefinition[] {
    return resolveNuxtDefinitions?.() ?? (resolved && buildStates.get(resolved)?.resolveDefinitions())
      ?? discoverQueueDefinitions({ contributions, rootDir: resolved?.root ?? process.cwd() })
  }
  let databasePlugin: DatabaseVitePlugin | undefined
  let postgresDatabase = false
  const database = () => ({ import: internalOptions.databaseImport, postgres: postgresDatabase })
  const nodeWrites = new Map<string, {
    cloudflareQueues: boolean
    definitions: DiscoveredQueueDefinition[] | undefined
    development: boolean
    nitroQueue: QueueOptions | undefined
    postgres: boolean
    queue: QueueOptions | undefined
  }>()
  function recordNodeWrite(rootDir: string, queue: QueueOptions | undefined, host: ViteHubHost | undefined, definitions: DiscoveredQueueDefinition[] | undefined) {
    if (host !== "node") return
    nodeWrites.set(rootDir, { cloudflareQueues, definitions, development: localDevelopment, nitroQueue, postgres: postgresDatabase, queue })
  }

  return {
    name: "@vite-hub/queue/vite",
    api: {
      deploymentEnv: context => queueDeploymentEnv(writtenQueue ?? normalizeQueueOptions(nitroQueue === false ? false : queue, { hosting: context.host, postgresDatabase })),
    },
    vitehub: {
      durability: () => {
        const resolvedQueue = writtenQueue ?? (nitroQueue === false ? undefined : normalizeQueueOptions(queue, { hosting }))
        if (!resolvedQueue || !resolvedQueue.driver) return []
        const base: unknown = Reflect.get(resolvedQueue, "base")
        const database: unknown = Reflect.get(resolvedQueue, "database")
        const input = { driver: resolvedQueue.driver, ...(typeof base === "string" ? { base } : {}), ...(typeof database === "string" ? { database } : {}) }
        return [{ export: "queueDurability", input, module: durabilityModuleFile(import.meta.url), primitive: "queue" }]
      },
      operations: [{ export: "queueOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).queueOperations, module: operationsModule }],
      inspect: () => {
        const resolvedQueue = normalizeQueueOptions(queue, { hosting })
        if (!resolvedQueue?.driver) return
        const rootDir = resolved?.root ?? process.cwd()
        const projectRoot = nuxtProjectRoot ?? (resolved && frameworkProjectRoot(resolved)) ?? resolveViteHubProjectRoot(rootDir)
        return {
          definitions: [{
            kind: "queue",
            label: "Queues",
            list: () => inspectQueueDefinitions({ projectRoot, rootDir }, discoverCurrentQueueDefinitions()),
          }],
          resources: () => resolvedQueue.driver === "cloudflare"
            ? inspectQueueResources({ binding: resolvedQueue.binding, namePrefix: resolvedQueue.namePrefix, projectRoot, rootDir }, discoverCurrentQueueDefinitions())
            : [],
        }
      },
      cli: async () => {
        return {
          namespaces: [],
          provision: [createQueueProvisionStep(
            discoverCurrentQueueDefinitions,
            () => {
              const resolvedQueue = normalizeQueueOptions(queue, { hosting: "cloudflare" })
              return resolvedQueue?.driver === "cloudflare" ? resolvedQueue.namePrefix : undefined
            },
          )],
        }
      },
      queue: {
        async createNitroConfig({ development = false, nitro, projectRoot, root, serverDirs, viteConfig }) {
          const config = viteConfig ?? { [VITEHUB_NITRO_CONFIG_CONTEXT]: true, nitro }
          const resolvedConfig = resolvedConfigs.get(root)
          const state = resolvedConfig ? buildStates.get(resolvedConfig) : undefined
          const projectQueue = viteConfig
            ? getResolvedFeatureOptions<QueueOptions>(viteConfig, "queue") ?? options
            : state ? state.queue : queueOptions.has(root) ? queueOptions.get(root) : options
          nuxtProjectRoot = projectRoot
          if (viteConfig) contributions = await collectPluginQueueContributions(viteConfig.plugins, root, projectRoot, serverDirs)
          const nuxtContributions = contributions
          nuxtServerQueueDirs = [...new Set(serverDirs || [resolve(projectRoot, "server"), resolve(root, "server")])]
            .map(dir => `${resolve(dir, "queues").replace(/\\/g, "/")}/`)
          resolveNuxtDefinitions = () => discoverQueueDefinitions({ contributions: nuxtContributions, rootDir: root, serverDirs, serverRootDirs: [projectRoot, root] })
          const definitions = resolveNuxtDefinitions()
          nuxtConfiguredDefinitions = definitions
          const configuredNitro = mergeNitroConfig(config, nitro, projectQueue, projectRoot, definitions)
          databasePlugin = findDatabasePlugin(viteConfig?.plugins) ?? databasePlugin
          const host = resolveQueueHost(config, configuredNitro)
          postgresDatabase = host === "node" && hasPostgresDefaultDatabase(databasePlugin)
          hosting = resolveQueueHosting(projectQueue, host, postgresDatabase)
          const nitroHosting = getHostingProvider(resolveHost({ nitro: configuredNitro }))
          const resolvedQueue = normalizeQueueOptions(projectQueue, { hosting: nitroHosting })
          nitroQueue = resolvedQueue?.driver && nitroHosting && resolvedQueue.driver !== nitroHosting ? false : projectQueue
          cloudflareQueues = supportsCloudflareQueues(configuredNitro)
          localDevelopment = development
          const nuxtState = { nuxtConfiguredDefinitions, nuxtProjectRoot, resolveNuxtDefinitions }
          nuxtStates.set(root, nuxtState)
          if (state) Object.assign(state, nuxtState)
          writtenQueue = await writeQueueNitroIntegration(projectRoot, nitroQueue, hosting, cloudflareQueues, definitions, localDevelopment, internalOptions.importBase, database())
          recordNodeWrite(projectRoot, projectQueue, host, definitions)
          return configuredNitro
        },
      },
    },
    async config(config, env) {
      preview = env?.isPreview === true
      queue = getResolvedFeatureOptions<QueueOptions>(config, "queue") ?? options
      queueOptions.set(resolve(config.root || process.cwd()), queue)
      // SAFETY: Vite preserves this ViteHub server directory field on config, while UserConfig omits framework extensions.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const root = config.root || process.cwd()
      const configuredRoot = frameworkProjectRoot(config)
      const outputRoot = configuredRoot ?? resolve(root)
      contributions = await collectPluginQueueContributions(config.plugins, root, configuredRoot)
      const nitro = (config as { nitro?: unknown }).nitro
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(config, nitro, queue, outputRoot, discoverViteQueueDefinitions(root, outputRoot, contributions))
      if (process.env.VITEST) {
        const testConfig: UserConfig & { test: { setupFiles: string[] } } = {
          test: { setupFiles: [resolve(outputRoot, generatedQueueTestSetup)] },
        }
        return testConfig
      }
    },
    async configResolved(config) {
      resolved = config
      const configuredRoot = frameworkProjectRoot(config)
      const nuxtState = nuxtStates.get(config.root) ?? (configuredRoot ? nuxtStates.get(configuredRoot) : undefined)
      nuxtConfiguredDefinitions = nuxtState?.nuxtConfiguredDefinitions
      nuxtProjectRoot = nuxtState?.nuxtProjectRoot
      resolveNuxtDefinitions = nuxtState?.resolveNuxtDefinitions
      const outputRoot = nuxtProjectRoot ?? configuredRoot ?? resolve(config.root)
      for (const root of new Set([config.root, outputRoot])) resolvedConfigs.set(root, config)
      queue = getResolvedFeatureOptions<QueueOptions>(config, "queue") ?? options
      for (const root of new Set([config.root, outputRoot])) queueOptions.set(root, queue)
      const configuredNitro = (config as { nitro?: unknown }).nitro
      contributions = await collectPluginQueueContributions(config.plugins, config.root, nuxtProjectRoot ?? configuredRoot)
      const resolveContributions = contributions
      const resolveDefinitions = resolveNuxtDefinitions ?? (() => discoverViteQueueDefinitions(config.root, outputRoot, resolveContributions))
      configuredDefinitions = resolveDefinitions()
      const nitro = mergeNitroConfig(config, configuredNitro, queue, outputRoot, configuredDefinitions)
      ;(config as { nitro?: unknown }).nitro = nitro
      databasePlugin = findDatabasePlugin(config.plugins) ?? databasePlugin
      const host = resolveQueueHost(config, nitro)
      postgresDatabase = host === "node" && hasPostgresDefaultDatabase(databasePlugin)
      hosting = resolveQueueHosting(queue, host, postgresDatabase)
      cloudflareQueues = supportsCloudflareQueues(nitro)
      const nitroHosting = getHostingProvider(resolveHost({ nitro }))
      const resolvedQueue = normalizeQueueOptions(queue, { hosting: nitroHosting })
      nitroQueue = resolvedQueue?.driver && nitroHosting && resolvedQueue.driver !== nitroHosting ? false : queue
      validatesNitroDefinitions = hasNitroConfigContext(config) && nitroQueue !== false
      localDevelopment = config.command === "serve" && !preview
      writtenQueue = await writeQueueNitroIntegration(outputRoot, nitroQueue, hosting, cloudflareQueues, configuredDefinitions, localDevelopment, internalOptions.importBase, database())
      recordNodeWrite(outputRoot, queue, host, configuredDefinitions)
      buildStates.set(config, {
        configuredDefinitions,
        contributions,
        nuxtConfiguredDefinitions,
        queue,
        resolveDefinitions,
        resolveNuxtDefinitions,
        resolved: config,
        validatesNitroDefinitions,
      })
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      const file = context.file.replace(/\\/g, "/")
      const isDirectoryDefinition = /\.(?:c|m)?[jt]s$/i.test(file)
        && (/\/server\/queues\//.test(file) || nuxtServerQueueDirs.some(dir => file.startsWith(dir)))
      if (!/\.queue\.(?:c|m)?[jt]s$/i.test(file) && !isDirectoryDefinition) return
      resolved = context.server.config
      const outputRoot = nuxtProjectRoot || frameworkProjectRoot(resolved) || resolve(resolved.root)
      const definitions = resolveNuxtDefinitions?.() ?? discoverViteQueueDefinitions(resolved.root, outputRoot, contributions)
      writtenQueue = await writeQueueNitroIntegration(outputRoot, nitroQueue, hosting, cloudflareQueues, definitions, localDevelopment, internalOptions.importBase, database())
    },
    async buildStart() {
      const databaseConfig = databasePlugin?.api?.getConfig?.()
      if (!databaseConfig) return
      postgresDatabase = databaseConfig.databases.default?.dialect === "postgresql"
      for (const [rootDir, write] of nodeWrites) {
        if (write.postgres === postgresDatabase) continue
        write.postgres = postgresDatabase
        hosting = resolveQueueHosting(write.queue, "node", postgresDatabase)
        writtenQueue = await writeQueueNitroIntegration(rootDir, write.nitroQueue, hosting, write.cloudflareQueues, write.definitions, write.development, internalOptions.importBase, database())
      }
    },
    buildEnd(error) {
      // SAFETY: Vite's environment config has the resolved config used to record this build state.
      const config = (this.environment?.config as ResolvedConfig | undefined) ?? resolved
      const state = config ? buildStates.get(config) : undefined
      if (error || !state || shouldSkipViteProviderBuild(state.resolved.command)) return
      if (state.resolveNuxtDefinitions && state.nuxtConfiguredDefinitions) {
        resolveStableQueueDefinitions(state.resolveNuxtDefinitions, state.nuxtConfiguredDefinitions, "Nuxt")
      }
      else if (state.validatesNitroDefinitions) {
        resolveStableQueueDefinitions(state.resolveDefinitions, state.configuredDefinitions, "Nitro")
      }
    },
  }
}
