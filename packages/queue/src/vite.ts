import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider, resolveHost, resolveHostPreset } from "@vite-hub/internal/hosting"
import { resolve } from "pathe"

import { normalizeQueueOptions } from "./config.ts"
import { discoverQueueDefinitions } from "./discovery.ts"
import { createCloudflareQueueBindings, createVercelQueueConsumerRoutes, generatedQueueNitroMiddleware, generatedQueueNitroPlugin, generatedQueueNitroVercelConsumerDir, queuePackageName, writeQueueNitroIntegration } from "./internal/vite-build.ts"
import { inspectQueueDefinitions } from "./inspect.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { Plugin, ResolvedConfig } from "vite"
import { queueErrorDiagnostics } from "./error-diagnostics.ts"

export { discoverQueueDefinitions } from "./discovery.ts"
export { inspectQueueDefinitions, type QueueInspectionOptions, queueConsoleSection } from "./inspect.ts"

interface QueueProvisionContributingPlugin {
  vitehub?: {
    cli?: () => Promise<ViteHubCliContributor>
    inspect?: () => ViteHubInspectionContributor | undefined
    queue?: {
      createNitroConfig: (options: QueueNitroConfigOptions) => Promise<Record<string, unknown>>
    }
  }
}

export type QueueVitePlugin = Plugin & QueueProvisionContributingPlugin

export interface QueueNitroConfigOptions {
  development?: boolean
  nitro: Record<string, unknown>
  projectRoot: string
  root: string
  serverDirs?: string[]
}

type QueueViteInternalOptions = {
  importBase?: string
  providerImportAliases?: Record<string, string>
}

const mergeNoExternal = createNoExternalAddition(queuePackageName)

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

function cloneNitroConfig(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {}
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function normalizeQueueForHosting(queue: QueueModuleOptions | undefined, hosting: string | undefined) {
  if (queue && typeof queue === "object" && Object.hasOwn(queue, "provider")) {
    const provider = (queue as Record<string, unknown>).provider
    const providerOnly = normalizeQueueOptions({ provider } as QueueModuleOptions, { hosting })
    if (providerOnly?.provider && hosting && providerOnly.provider !== hosting) return undefined
  }
  return normalizeQueueOptions(queue, { hosting })
}

function resolveQueueHosting(queue: QueueModuleOptions | undefined, nitro: Record<string, unknown>): string {
  const hosting = getHostingProvider(resolveHost({ nitro }))
  return hosting || normalizeQueueForHosting(queue, hosting)?.provider || "vercel"
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

/** Vercel delivers Queue messages to Nitro routes that have a queue trigger in `vercel.functionRules`. */
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

function mergeNitroConfig(config: object, value: unknown, queue: QueueModuleOptions | undefined, root: string, definitions = discoverQueueDefinitions({ rootDir: root })): Record<string, unknown> {
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
  const queueHosting = resolveQueueHosting(queue, nitro)
  const resolvedVercelQueue = queueHosting === "vercel" ? normalizeQueueOptions(queue, { hosting: queueHosting }) : undefined
  if (resolvedVercelQueue && resolvedVercelQueue.provider === "vercel" && hostsVercelQueueConsumers(nitro)) {
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
  const generated = createCloudflareQueueBindings(definitions, resolvedQueue?.provider === "cloudflare" ? resolvedQueue.namePrefix : undefined)
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
  const binding = resolvedQueue?.provider === "cloudflare" && typeof resolvedQueue.binding === "string" ? resolvedQueue.binding : undefined
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

export function hubQueue(options?: QueueModuleOptions): QueueVitePlugin {
  const internalOptions = options as QueueModuleOptions & QueueViteInternalOptions | undefined
  let resolved: ResolvedConfig | undefined
  let queue: QueueModuleOptions | undefined = options
  let hosting = "vercel"
  let cloudflareQueues = true
  let configuredDefinitions: DiscoveredQueueDefinition[] = []
  let localDevelopment = false
  let nitroQueue: QueueModuleOptions | undefined = queue
  let nuxtConfiguredDefinitions: DiscoveredQueueDefinition[] | undefined
  let nuxtProjectRoot: string | undefined
  let resolveNuxtDefinitions: (() => DiscoveredQueueDefinition[]) | undefined
  let nuxtServerQueueDirs: string[] = []
  const resolvedConfigs = new Map<string, ResolvedConfig>()
  const queueOptions = new Map<string, QueueModuleOptions | undefined>()
  const nuxtStates = new Map<string, {
    nuxtConfiguredDefinitions: DiscoveredQueueDefinition[]
    nuxtProjectRoot: string
    resolveNuxtDefinitions: () => DiscoveredQueueDefinition[]
  }>()
  // Nitro reads the Cloudflare bindings and Vercel queue triggers from the Definitions found at config time.
  const buildStates = new WeakMap<ResolvedConfig, {
    configuredDefinitions: DiscoveredQueueDefinition[]
    nuxtConfiguredDefinitions: DiscoveredQueueDefinition[] | undefined
    queue: QueueModuleOptions | undefined
    resolveNuxtDefinitions: (() => DiscoveredQueueDefinition[]) | undefined
    resolved: ResolvedConfig
    validatesNitroDefinitions: boolean
  }>()
  let validatesNitroDefinitions = false
  let serverDirs: string[] | undefined

  return {
    name: "@vite-hub/queue/vite",
    vitehub: {
      inspect: () => {
        const provider = normalizeQueueOptions(queue, { hosting })?.provider
        if (!provider) return
        return {
          definitions: [{
            kind: "queue",
            label: "Queues",
            list: () => {
              const rootDir = resolved?.root ?? process.cwd()
              return inspectQueueDefinitions({ projectRoot: resolveViteHubProjectRoot(rootDir), rootDir, serverDirs })
            },
          }],
        }
      },
      cli: async () => {
        return {
          namespaces: [],
          provision: [createQueueProvisionStep(
            () => resolved?.root ?? process.cwd(),
            () => {
              const resolvedQueue = normalizeQueueOptions(queue, { hosting: "cloudflare" })
              return resolvedQueue?.provider === "cloudflare" ? resolvedQueue.namePrefix : undefined
            },
          )],
        }
      },
      queue: {
        async createNitroConfig({ development = false, nitro, projectRoot, root, serverDirs }) {
          const config = { [VITEHUB_NITRO_CONFIG_CONTEXT]: true, nitro }
          const resolvedConfig = resolvedConfigs.get(root)
          const state = resolvedConfig ? buildStates.get(resolvedConfig) : undefined
          const projectQueue = state ? state.queue : queueOptions.has(root) ? queueOptions.get(root) : options
          nuxtProjectRoot = projectRoot
          nuxtServerQueueDirs = [...new Set(serverDirs || [resolve(projectRoot, "server"), resolve(root, "server")])]
            .map(dir => `${resolve(dir, "queues").replace(/\\/g, "/")}/`)
          resolveNuxtDefinitions = () => discoverQueueDefinitions({ rootDir: root, serverDirs, serverRootDirs: [projectRoot, root] })
          const definitions = resolveNuxtDefinitions()
          nuxtConfiguredDefinitions = definitions
          const configuredNitro = mergeNitroConfig(config, nitro, projectQueue, projectRoot, definitions)
          hosting = resolveQueueHosting(projectQueue, configuredNitro)
          const nitroHosting = getHostingProvider(resolveHost({ nitro: configuredNitro }))
          const resolvedQueue = normalizeQueueOptions(projectQueue, { hosting: nitroHosting })
          nitroQueue = resolvedQueue?.provider && nitroHosting && resolvedQueue.provider !== nitroHosting ? false : projectQueue
          cloudflareQueues = supportsCloudflareQueues(configuredNitro)
          localDevelopment = development
          // Nuxt can configure Nitro after another project's Vite config resolves.
          const nuxtState = { nuxtConfiguredDefinitions, nuxtProjectRoot, resolveNuxtDefinitions }
          nuxtStates.set(root, nuxtState)
          if (state) Object.assign(state, nuxtState)
          await writeQueueNitroIntegration(projectRoot, nitroQueue, hosting, cloudflareQueues, definitions, localDevelopment, internalOptions?.importBase)
          return configuredNitro
        },
      },
    },
    config(config) {
      queue = config.queue ?? options
      queueOptions.set(resolve(config.root || process.cwd()), queue)
      // SAFETY: Vite preserves this ViteHub server directory field on config, while UserConfig omits framework extensions.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const nitro = (config as { nitro?: unknown }).nitro
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(config, nitro, queue, config.root || process.cwd())
    },
    async configResolved(config) {
      resolved = config
      resolvedConfigs.set(config.root, config)
      const nuxtState = nuxtStates.get(config.root)
      nuxtConfiguredDefinitions = nuxtState?.nuxtConfiguredDefinitions
      nuxtProjectRoot = nuxtState?.nuxtProjectRoot
      resolveNuxtDefinitions = nuxtState?.resolveNuxtDefinitions
      queue = config.queue ?? options
      queueOptions.set(config.root, queue)
      const configuredNitro = (config as { nitro?: unknown }).nitro
      configuredDefinitions = discoverQueueDefinitions({ rootDir: config.root })
      const nitro = mergeNitroConfig(config, configuredNitro, queue, config.root, configuredDefinitions)
      ;(config as { nitro?: unknown }).nitro = nitro
      hosting = resolveQueueHosting(queue, nitro)
      cloudflareQueues = supportsCloudflareQueues(nitro)
      const nitroHosting = getHostingProvider(resolveHost({ nitro }))
      const resolvedQueue = normalizeQueueOptions(queue, { hosting: nitroHosting })
      nitroQueue = resolvedQueue?.provider && nitroHosting && resolvedQueue.provider !== nitroHosting ? false : queue
      validatesNitroDefinitions = hasNitroConfigContext(config) && nitroQueue !== false
      localDevelopment = config.command === "serve"
      await writeQueueNitroIntegration(config.root, nitroQueue, hosting, cloudflareQueues, configuredDefinitions, localDevelopment, internalOptions?.importBase)
      buildStates.set(config, {
        configuredDefinitions,
        nuxtConfiguredDefinitions,
        queue,
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
      await writeQueueNitroIntegration(nuxtProjectRoot || resolved.root, nitroQueue, hosting, cloudflareQueues, resolveNuxtDefinitions?.(), localDevelopment, internalOptions?.importBase)
    },
    buildEnd(error) {
      // SAFETY: Vite's environment config has the resolved config used to record this build state.
      const config = (this.environment?.config as ResolvedConfig | undefined) ?? resolved
      const state = config ? buildStates.get(config) : undefined
      if (error || !state || shouldSkipViteProviderBuild(state.resolved.command, getViteMode())) return
      if (state.resolveNuxtDefinitions && state.nuxtConfiguredDefinitions) {
        resolveStableQueueDefinitions(state.resolveNuxtDefinitions, state.nuxtConfiguredDefinitions, "Nuxt")
      }
      else if (state.validatesNitroDefinitions) {
        resolveStableQueueDefinitions(() => discoverQueueDefinitions({ rootDir: state.resolved.root }), state.configuredDefinitions, "Nitro")
      }
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
