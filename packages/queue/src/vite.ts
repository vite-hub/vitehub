import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, contributeCloudflareProviderOutput, contributeProviderDeploymentOutput, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { createNoExternalMerger, hasNitroConfigContext, isServerEnvironment, resolveNitroVercelFunctionName } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { resolve } from "pathe"

import { normalizeQueueOptions } from "./config.ts"
import { discoverQueueDefinitions } from "./discovery.ts"
import { createCloudflareQueueBindings, generateProviderOutputs, generatedQueueNitroMiddleware, generatedQueueNitroPlugin, queuePackageName, writeQueueNitroIntegration, writeQueueRegistry } from "./internal/vite-build.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions, QueueProvider } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"

interface QueueProvisionContributingPlugin {
  vitehub?: {
    cli?: () => Promise<ViteHubCliContributor>
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
  providerImportAliases?: Record<string, string>
}

export { createCloudflareQueueConfig, type CloudflareQueueConfig, type CloudflareQueueConfigOptions } from "./internal/vite-build.ts"

const mergeNoExternal = createNoExternalMerger(queuePackageName)

export async function createQueueNitroConfig(plugin: QueueVitePlugin, options: QueueNitroConfigOptions): Promise<Record<string, unknown>> {
  const createNitroConfig = plugin.vitehub?.queue?.createNitroConfig
  if (!createNitroConfig) {
    throw new Error("The existing @vite-hub/queue/vite plugin does not expose Queue Nitro configuration.")
  }
  return createNitroConfig(options)
}

function resolveStableQueueDefinitions(resolveDefinitions: () => DiscoveredQueueDefinition[], snapshot: DiscoveredQueueDefinition[], context: string) {
  const definitions = resolveDefinitions()
  if (JSON.stringify(definitions) !== JSON.stringify(snapshot)) {
    throw new Error(`[vitehub] ${context} Queue Definitions changed after config resolution. Generate Queue Definition source files before Vite config resolves.`)
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

function mergeNitroConfig(config: object, value: unknown, queue: QueueModuleOptions | undefined, root: string, definitions = discoverQueueDefinitions({ rootDir: root })): Record<string, unknown> {
  const providerOutput = useProviderOutputCatalog(config)
  const nitro = cloneNitroConfig(value)
  const nitroHosting = resolveNitroHosting(nitro)
  const providerMismatch = queue !== false && queue?.provider && nitroHosting && queue.provider !== nitroHosting
  const runtimeEnabled = queue !== false && !providerMismatch
  const plugins = Array.isArray(nitro.plugins) ? nitro.plugins.filter(plugin => runtimeEnabled || plugin !== generatedQueueNitroPlugin) : []
  const handlers = Array.isArray(nitro.handlers)
    ? nitro.handlers.filter(handler => handler?.handler !== generatedQueueNitroMiddleware)
    : []
  if (!runtimeEnabled) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, { ...nitro, handlers, plugins }, value)
  }
  if (!plugins.includes(generatedQueueNitroPlugin)) plugins.unshift(generatedQueueNitroPlugin)
  handlers.unshift({ handler: generatedQueueNitroMiddleware, middleware: true, route: "/**" })
  const queueHosting = resolveQueueHosting(queue, nitro)
  if (queueHosting !== "cloudflare") {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, { ...nitro, handlers, plugins }, value)
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
    handlers,
    plugins,
  }
  if (!generated) {
    contributeCloudflareProviderOutput(providerOutput, { owner: "queue" })
    return composeNitroCloudflareProviderOutput(providerOutput, baseNitro, value)
  }
  const binding = resolvedQueue?.provider === "cloudflare" && typeof resolvedQueue.binding === "string" ? resolvedQueue.binding : undefined
  if (binding && generated.producers.length > 1) {
    throw new Error("A custom Cloudflare queue binding can only be used with one Queue Definition.")
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
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
  let validatesNitroDefinitions = false

  return {
    name: "@vite-hub/queue/vite",
    vitehub: {
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
          const config = { nitro }
          nuxtProjectRoot = projectRoot
          nuxtServerQueueDirs = [...new Set(serverDirs || [resolve(projectRoot, "server"), resolve(root, "server")])]
            .map(dir => `${resolve(dir, "queues").replace(/\\/g, "/")}/`)
          resolveNuxtDefinitions = () => discoverQueueDefinitions({ rootDir: root, serverDirs, serverRootDirs: [projectRoot, root] })
          const definitions = resolveNuxtDefinitions()
          nuxtConfiguredDefinitions = definitions
          const configuredNitro = mergeNitroConfig(config, nitro, queue, projectRoot, definitions)
          hosting = resolveQueueHosting(queue, configuredNitro)
          const nitroHosting = resolveNitroHosting(configuredNitro)
          nitroQueue = queue !== false && queue?.provider && nitroHosting && queue.provider !== nitroHosting ? false : queue
          cloudflareQueues = supportsCloudflareQueues(configuredNitro)
          nuxtOwnsCloudflareWorker = nitroQueue !== false && nitroHosting === "cloudflare" && cloudflareQueues
          localDevelopment = development
          await writeQueueNitroIntegration(projectRoot, nitroQueue, hosting, cloudflareQueues, definitions, localDevelopment)
          return configuredNitro
        },
      },
    },
    config(config) {
      queue = config.queue ?? queue
      const nitro = (config as { nitro?: unknown }).nitro
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(config, nitro, queue, config.root || process.cwd())
    },
    async configResolved(config) {
      resolved = config
      queue = config.queue ?? queue
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
      await writeQueueNitroIntegration(config.root, nitroQueue, hosting, cloudflareQueues, configuredDefinitions, localDevelopment)
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
      await writeQueueNitroIntegration(nuxtProjectRoot || resolved.root, nitroQueue, hosting, cloudflareQueues, resolveNuxtDefinitions?.(), localDevelopment)
    },
    buildStart() {
      providerOutputGenerations.capture(this, providerOutput)
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      let artifactDir: string | undefined
      try {
        let definitions: DiscoveredQueueDefinition[] | undefined
        if (resolveNuxtDefinitions && nuxtConfiguredDefinitions) {
          definitions = resolveStableQueueDefinitions(resolveNuxtDefinitions, nuxtConfiguredDefinitions, "Nuxt")
        }
        else if (validatesNitroDefinitions) {
          definitions = resolveStableQueueDefinitions(
            () => discoverQueueDefinitions({ rootDir: resolved!.root }),
            configuredDefinitions,
            "Nitro Cloudflare",
          )
        }
        else {
          definitions = discoverQueueDefinitions({ rootDir: resolved.root })
        }
        const config = resolved
        const rootDir = nuxtProjectRoot || config.root
        artifactDir = resolve(rootDir, ".vitehub/queue-generations", randomUUID())
        const contributionArtifactDir = artifactDir
        const providerImportAliases = internalOptions?.providerImportAliases ?? {}
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(contributionArtifactDir, "sources"),
          paths: [...definitions.map(definition => definition.handler), ...Object.values(providerImportAliases)],
          roots: [rootDir],
        })
        const retainedDefinitions = definitions.map(definition => ({
          ...definition,
          handler: retainedSources.resolve(definition.handler),
        }))
        const retainedProviderImportAliases = Object.fromEntries(Object.entries(providerImportAliases)
          .map(([specifier, target]) => [specifier, retainedSources.resolve(target)]))
        // SAFETY: Vite preserves the user-defined Nitro field on the resolved config, while ResolvedConfig omits framework extensions from its type.
        const nitro = (config as { nitro?: unknown }).nitro
        contributeProviderDeploymentOutput(providerOutput, {
          discard: async () => await rm(contributionArtifactDir, { force: true, recursive: true }),
          owner: "queue",
          rootDir,
          write: async ({ signal, write }) => {
            await generateProviderOutputs({
              artifactDir: resolve(contributionArtifactDir, "output"),
              clientOutDir: config.build.outDir,
              cloudflareOwnedByNitro: nitroOwnsCloudflareWorker || nuxtOwnsCloudflareWorker,
              definitions: retainedDefinitions,
              providerImportAliases: retainedProviderImportAliases,
              providerOutput,
              queue: queue ?? (resolveNitroHosting(cloneNitroConfig(nitro))
                ? { provider: (hosting === "cloudflare" ? "cloudflare" : "vercel") satisfies QueueProvider }
                : undefined),
              rootDir,
              sourceRootDir: retainedSources.resolve(rootDir),
              serverFunctionName: resolveNitroVercelFunctionName(config, "queue"),
              signal,
            }, write)
            signal.throwIfAborted()
            await writeQueueRegistry(rootDir, definitions)
          },
        }, providerOutputGenerations.get(this))
      }
      catch (error) {
        if (artifactDir) await rm(artifactDir, { force: true, recursive: true })
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
    },
    async renderError(error) {
      await providerOutputGenerations.reset(this, providerOutput, error)
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
