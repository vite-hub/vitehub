import { randomUUID } from "node:crypto"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, contributeProviderDeploymentOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir, retainProviderOutputAliases, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { resolve } from "pathe"

import { normalizeQueueOptions } from "./config.ts"
import { discoverQueueDefinitions } from "./discovery.ts"
import { captureQueueProviderRuntimeInputs, createCloudflareQueueBindings, generateProviderOutputs, generatedQueueNitroMiddleware, generatedQueueNitroPlugin, queuePackageName, writeQueueNitroIntegration, writeQueueRegistry } from "./internal/vite-build.ts"
import type { QueueProviderRuntimeInputs } from "./internal/vite-build.ts"
import { inspectQueueDefinitions } from "./inspect.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions, QueueProvider } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
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

export { createCloudflareQueueConfig, type CloudflareQueueConfig, type CloudflareQueueConfigOptions } from "./internal/vite-build.ts"

const mergeNoExternal = createNoExternalAddition(queuePackageName)

export async function createQueueNitroConfig(plugin: QueueVitePlugin, options: QueueNitroConfigOptions): Promise<Record<string, unknown>> {
  const createNitroConfig = plugin.vitehub?.queue?.createNitroConfig
  if (!createNitroConfig) {
    throw queueErrorDiagnostics.QUEUE_B0001({ message: "The existing @vite-hub/queue/vite plugin does not expose Queue Nitro configuration." })
  }
  return createNitroConfig(options)
}

function resolveStableQueueDefinitions(resolveDefinitions: () => DiscoveredQueueDefinition[], snapshot: DiscoveredQueueDefinition[], context: string) {
  const definitions = resolveDefinitions()
  if (JSON.stringify(definitions) !== JSON.stringify(snapshot)) {
    throw queueErrorDiagnostics.QUEUE_B0002({ message: `[vitehub] ${context} Queue Definitions changed after config resolution. Generate Queue Definition source files before Vite config resolves.` })
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

function resolveQueueHosting(queue: QueueModuleOptions | undefined, nitro: Record<string, unknown>): string {
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
  return getHostingProvider(preset) || (queue !== false && queue?.provider) || "vercel"
}

function resolveNitroHosting(nitro: Record<string, unknown>): string | undefined {
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
  return getHostingProvider(preset)
}

function supportsCloudflareQueues(nitro: Record<string, unknown>): boolean {
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING || ""
  return !preset.replaceAll("-", "_").includes("cloudflare_pages")
}

function isGeneratedNitroRegistration(value: unknown, generatedPath: string): boolean {
  return typeof value === "string"
    && (value === generatedPath || value.replaceAll("\\", "/").endsWith(`/${generatedPath}`))
}

function mergeNitroConfig(config: object, value: unknown, queue: QueueModuleOptions | undefined, root: string, definitions = discoverQueueDefinitions({ rootDir: root })): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const nitroHosting = resolveNitroHosting(nitro)
  const providerMismatch = queue !== false && queue?.provider && nitroHosting && queue.provider !== nitroHosting
  const runtimeEnabled = queue !== false && !providerMismatch
  const nitroOwnsPaths = hasNitroConfigContext(config)
  const plugin = nitroOwnsPaths ? resolve(root, generatedQueueNitroPlugin) : generatedQueueNitroPlugin
  const middleware = nitroOwnsPaths ? resolve(root, generatedQueueNitroMiddleware) : generatedQueueNitroMiddleware
  nitro.plugins = Array.isArray(nitro.plugins)
    ? nitro.plugins.filter(entry => !isGeneratedNitroRegistration(entry, generatedQueueNitroPlugin))
    : []
  nitro.handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler => !isGeneratedNitroRegistration(handler?.handler, generatedQueueNitroMiddleware))
    : []
  const kit = createNitroServerKit(nitro)
  if (!runtimeEnabled) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, kit.config, value)
  }
  kit.addPlugin(plugin, "start")
  kit.addHandler({ handler: middleware, middleware: true, route: "/**" }, "start")
  const queueHosting = resolveQueueHosting(queue, nitro)
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
    throw queueErrorDiagnostics.QUEUE_B0003({ message: "A custom Cloudflare queue binding can only be used with one Queue Definition." })
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
  let nitroOwnsCloudflareWorker = false
  let nitroQueue: QueueModuleOptions | undefined = queue
  let nuxtConfiguredDefinitions: DiscoveredQueueDefinition[] | undefined
  let nuxtProjectRoot: string | undefined
  let resolveNuxtDefinitions: (() => DiscoveredQueueDefinition[]) | undefined
  let nuxtServerQueueDirs: string[] = []
  let nuxtOwnsCloudflareWorker = false
  let providerOutput: ProviderOutputCatalog | undefined
  const resolvedConfigs = new Map<string, ResolvedConfig>()
  const queueOptions = new Map<string, QueueModuleOptions | undefined>()
  const nuxtStates = new Map<string, {
    nuxtConfiguredDefinitions: DiscoveredQueueDefinition[]
    nuxtProjectRoot: string
    resolveNuxtDefinitions: () => DiscoveredQueueDefinition[]
    nuxtOwnsCloudflareWorker: boolean
  }>()
  const buildStates = new WeakMap<ResolvedConfig, {
    configuredDefinitions: DiscoveredQueueDefinition[]
    queue: QueueModuleOptions | undefined
    hosting: string
    cloudflareQueues: boolean
    localDevelopment: boolean
    nitroOwnsCloudflareWorker: boolean
    nitroQueue: QueueModuleOptions | undefined
    nuxtConfiguredDefinitions: DiscoveredQueueDefinition[] | undefined
    nuxtProjectRoot: string | undefined
    resolveNuxtDefinitions: (() => DiscoveredQueueDefinition[]) | undefined
    nuxtOwnsCloudflareWorker: boolean
    providerOutput: ProviderOutputCatalog | undefined
    resolved: ResolvedConfig
    validatesNitroDefinitions: boolean
  }>()
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let validatesNitroDefinitions = false
  let serverDirs: string[] | undefined
  const queueOutputRoot = (provider: QueueProvider) => {
    const rootDir = nuxtProjectRoot ?? resolved?.root ?? process.cwd()
    // SAFETY: Nitro adds this optional output config to Vite's resolved config; its directory remains unknown until checked below.
    const outputDir = (resolved as (ResolvedConfig & { nitro?: { output?: { dir?: unknown } } }) | undefined)?.nitro?.output?.dir
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Nitro output.dir is an unknown config value at this integration boundary; only strings are valid paths.
    if (provider === "cloudflare" && (nitroOwnsCloudflareWorker || nuxtOwnsCloudflareWorker) && typeof outputDir === "string") return resolve(rootDir, outputDir)
    return provider === "cloudflare" ? createDefaultCloudflareOutputRoot(rootDir) : createDefaultVercelOutputRoot(rootDir)
  }

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
          providerOutput: [
            provider === "cloudflare"
              ? {
                  description: "Generated Cloudflare Queue provider config",
                  owner: "queue",
                  path: resolve(queueOutputRoot(provider), nitroOwnsCloudflareWorker || nuxtOwnsCloudflareWorker ? "server/wrangler.json" : "wrangler.json"),
                }
              : {
                  description: "Generated Vercel Queue provider config",
                  owner: "queue",
                  path: resolve(queueOutputRoot(provider), "config.json"),
                },
          ],
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
          const nitroHosting = resolveNitroHosting(configuredNitro)
          nitroQueue = projectQueue !== false && projectQueue?.provider && nitroHosting && projectQueue.provider !== nitroHosting ? false : projectQueue
          cloudflareQueues = supportsCloudflareQueues(configuredNitro)
          nuxtOwnsCloudflareWorker = nitroQueue !== false && nitroHosting === "cloudflare" && cloudflareQueues
          localDevelopment = development
          // Nuxt can configure Nitro after another project's Vite config resolves.
          const nuxtState = { nuxtConfiguredDefinitions, nuxtProjectRoot, resolveNuxtDefinitions, nuxtOwnsCloudflareWorker }
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
      nuxtOwnsCloudflareWorker = nuxtState?.nuxtOwnsCloudflareWorker ?? false
      queue = config.queue ?? options
      queueOptions.set(config.root, queue)
      const configuredNitro = (config as { nitro?: unknown }).nitro
      const configuredNitroConfig = cloneNitroConfig(configuredNitro)
      nitroOwnsCloudflareWorker = hasNitroConfigContext(config) && resolveNitroHosting(configuredNitroConfig) === "cloudflare" && supportsCloudflareQueues(configuredNitroConfig)
      configuredDefinitions = discoverQueueDefinitions({ rootDir: config.root })
      const nitro = mergeNitroConfig(config, configuredNitro, queue, config.root, configuredDefinitions)
      ;(config as { nitro?: unknown }).nitro = nitro
      providerOutput = useProviderOutputCatalog(config)
      hosting = resolveQueueHosting(queue, nitro)
      cloudflareQueues = supportsCloudflareQueues(nitro)
      const nitroHosting = resolveNitroHosting(nitro)
      nitroQueue = queue !== false && queue?.provider && nitroHosting && queue.provider !== nitroHosting ? false : queue
      validatesNitroDefinitions = hasNitroConfigContext(config) && nitroQueue !== false
      localDevelopment = config.command === "serve"
      await writeQueueNitroIntegration(config.root, nitroQueue, hosting, cloudflareQueues, configuredDefinitions, localDevelopment, internalOptions?.importBase)
      buildStates.set(config, {
        configuredDefinitions,
        queue,
        hosting,
        cloudflareQueues,
        localDevelopment,
        nitroOwnsCloudflareWorker,
        nitroQueue,
        nuxtConfiguredDefinitions,
        nuxtProjectRoot,
        resolveNuxtDefinitions,
        nuxtOwnsCloudflareWorker,
        providerOutput,
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
    buildStart() {
      // SAFETY: Vite's environment config has the resolved config used to record this build state.
      const config = (this.environment?.config as ResolvedConfig | undefined) ?? resolved
      const state = config ? buildStates.get(config) : undefined
      providerOutputGenerations.capture(this, state?.providerOutput ?? providerOutput)
    },
    async buildEnd(error) {
      // SAFETY: Vite's environment config has the resolved config used to record this build state.
      const config = (this.environment?.config as ResolvedConfig | undefined) ?? resolved
      const state = config ? buildStates.get(config) : undefined
      const buildResolved = state?.resolved ?? resolved
      const buildProviderOutput = state?.providerOutput ?? providerOutput
      const buildConfiguredDefinitions = state ? state.configuredDefinitions : configuredDefinitions
      const buildHosting = state ? state.hosting : hosting
      const buildNitroOwnsCloudflareWorker = state ? state.nitroOwnsCloudflareWorker : nitroOwnsCloudflareWorker
      const buildNuxtOwnsCloudflareWorker = state ? state.nuxtOwnsCloudflareWorker : nuxtOwnsCloudflareWorker
      const buildNuxtConfiguredDefinitions = state ? state.nuxtConfiguredDefinitions : nuxtConfiguredDefinitions
      const buildNuxtProjectRoot = state ? state.nuxtProjectRoot : nuxtProjectRoot
      const buildResolveNuxtDefinitions = state ? state.resolveNuxtDefinitions : resolveNuxtDefinitions
      const buildValidatesNitroDefinitions = state ? state.validatesNitroDefinitions : validatesNitroDefinitions
      const buildQueue = state ? state.queue : queue
      if (error) {
        await providerOutputGenerations.reset(this, buildProviderOutput, error)
        return
      }
      if (!buildResolved || shouldSkipViteProviderBuild(buildResolved.command, getViteMode())) {
        return
      }
      let artifactDir: string | undefined
      try {
        let definitions: DiscoveredQueueDefinition[] | undefined
        if (buildResolveNuxtDefinitions && buildNuxtConfiguredDefinitions) {
          definitions = resolveStableQueueDefinitions(buildResolveNuxtDefinitions, buildNuxtConfiguredDefinitions, "Nuxt")
        }
        else if (buildValidatesNitroDefinitions) {
          definitions = resolveStableQueueDefinitions(
            () => discoverQueueDefinitions({ rootDir: buildResolved!.root }),
            buildConfiguredDefinitions,
            "Nitro Cloudflare",
          )
        }
        else {
          definitions = discoverQueueDefinitions({ rootDir: buildResolved.root })
        }
        const config = buildResolved
        const rootDir = buildNuxtProjectRoot || config.root
        artifactDir = resolve(rootDir, ".vitehub/queue-generations", randomUUID())
        const contributionArtifactDir = artifactDir
        const providerImportAliases = internalOptions?.providerImportAliases ?? {}
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(contributionArtifactDir, "sources"),
          paths: [
            ...definitions.map(definition => definition.handler),
            ...Object.keys(providerImportAliases),
            ...Object.values(providerImportAliases),
          ],
          roots: [rootDir],
        })
        const retainedDefinitions = definitions.map(definition => ({
          ...definition,
          handler: retainedSources.resolve(definition.handler),
        }))
        const retainedProviderImportAliases = retainProviderOutputAliases(providerImportAliases, retainedSources)
        // SAFETY: Vite preserves the user-defined Nitro field on the resolved config, while ResolvedConfig omits framework extensions from its type.
        const nitro = (config as { nitro?: unknown }).nitro
        const generation = providerOutputGenerations.get(this)
        contributeProviderDeploymentOutput(buildProviderOutput, {
          discard: async () => await removeProviderOutputArtifactDir(contributionArtifactDir),
          owner: "queue",
          rootDir,
          write: async ({ signal, write }) => {
            const providerRuntimeInputs = captureQueueProviderRuntimeInputs(buildProviderOutput, retainedProviderImportAliases, generation)
            const retainedRuntimeSources = await retainProviderOutputSources({
              artifactDir: resolve(contributionArtifactDir, "runtime-sources"),
              paths: Object.values(providerRuntimeInputs.aliases).flatMap(aliases => [
                ...Object.keys(aliases),
                ...Object.values(aliases),
              ]),
              roots: [rootDir],
            })
            const retainedRuntimeAliases = Object.fromEntries(Object.entries(providerRuntimeInputs.aliases)
              .map(([provider, aliases]) => [provider, retainProviderOutputAliases(aliases, retainedRuntimeSources)]))
            // SAFETY: The outer entries preserve provider keys and each inner entry preserves string alias targets.
            const typedRetainedRuntimeAliases = retainedRuntimeAliases as QueueProviderRuntimeInputs["aliases"]
            await generateProviderOutputs({
              artifactDir: resolve(contributionArtifactDir, "output"),
              bundleDefines: buildProviderOutput?.bundleDefines,
              clientOutDir: config.build.outDir,
              cloudflareOwnedByNitro: buildNitroOwnsCloudflareWorker || buildNuxtOwnsCloudflareWorker,
              definitions: retainedDefinitions,
              providerImportAliases: retainedProviderImportAliases,
              providerRuntimeInputs: {
                aliases: typedRetainedRuntimeAliases,
                vercelPackages: providerRuntimeInputs.vercelPackages.filter(runtimePackage => runtimePackage.name === "@vite-hub/blob"),
              },
              queue: buildQueue ?? (resolveNitroHosting(cloneNitroConfig(nitro))
                ? { provider: (buildHosting === "cloudflare" ? "cloudflare" : "vercel") satisfies QueueProvider }
                : undefined),
              rootDir,
              sourceRootDir: retainedSources.resolve(rootDir),
              serverFunctionName: resolveNitroVercelFunctionName(config, "queue"),
              signal,
            }, write)
            signal.throwIfAborted()
            await writeQueueRegistry(rootDir, definitions)
          },
        }, generation)
      }
      catch (error) {
        if (artifactDir) await removeProviderOutputArtifactDir(artifactDir)
        await providerOutputGenerations.reset(this, buildProviderOutput, error)
        throw error
      }
    },
    async renderError(error) {
      // SAFETY: Vite's environment config has the resolved config used to record this build state.
      const config = (this.environment?.config as ResolvedConfig | undefined) ?? resolved
      const state = config ? buildStates.get(config) : undefined
      await providerOutputGenerations.reset(this, state?.providerOutput ?? providerOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
      async handler() {
        // SAFETY: Vite's environment config has the resolved config used to record this build state.
        const config = (this.environment?.config as ResolvedConfig | undefined) ?? resolved
        const state = config ? buildStates.get(config) : undefined
        if (!config || shouldSkipViteProviderBuild(config.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(state?.providerOutput ?? providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
