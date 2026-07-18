import { getViteMode } from "@vite-hub/internal/build/mode"
import { composeNitroCloudflareProviderOutput, registerCloudflareProviderOutput, shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import { createCloudflareQueueBindings, generateProviderOutputs, generatedQueueNitroPlugin, queuePackageName, writeQueueNitroIntegration } from "./internal/vite-build.ts"
import { discoverQueueDefinitions } from "./discovery.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { QueueModuleOptions, QueueProvider } from "./types.ts"
import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { Plugin, ResolvedConfig } from "vite"

interface QueueProvisionContributingPlugin {
  vitehub?: { cli?: () => Promise<ViteHubCliContributor> }
}

export type QueueVitePlugin = Plugin & QueueProvisionContributingPlugin

export { createCloudflareQueueConfig, type CloudflareQueueConfig, type CloudflareQueueConfigOptions } from "./internal/vite-build.ts"

const mergeNoExternal = createNoExternalMerger(queuePackageName)

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
  if (queue !== false && queue?.provider) return queue.provider
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
  return getHostingProvider(preset) || "vercel"
}

function supportsCloudflareQueues(nitro: Record<string, unknown>): boolean {
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING || ""
  return !preset.replaceAll("-", "_").includes("cloudflare_pages")
}

function mergeNitroConfig(config: object, value: unknown, queue: QueueModuleOptions | undefined, root: string): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const plugins = Array.isArray(nitro.plugins) ? nitro.plugins.filter(plugin => queue !== false || plugin !== generatedQueueNitroPlugin) : []
  if (queue === false) {
    registerCloudflareProviderOutput(config, "queue", {})
    return { ...nitro, plugins }
  }
  if (!plugins.includes(generatedQueueNitroPlugin)) plugins.unshift(generatedQueueNitroPlugin)
  if (resolveQueueHosting(queue, nitro) !== "cloudflare") {
    registerCloudflareProviderOutput(config, "queue", {})
    return { ...nitro, plugins }
  }
  const cloudflare = cloneNitroConfig(nitro.cloudflare)
  const wrangler = cloneNitroConfig(cloudflare.wrangler)
  const compatibilityFlags = Array.isArray(wrangler.compatibility_flags) ? [...wrangler.compatibility_flags] : []
  if (!compatibilityFlags.includes("nodejs_compat")) compatibilityFlags.push("nodejs_compat")
  const cloudflareQueues = supportsCloudflareQueues(nitro)
  const rollupConfig = cloneNitroConfig(nitro.rollupConfig)
  const generated = createCloudflareQueueBindings(discoverQueueDefinitions({ rootDir: root }))
  const baseNitro = {
    ...nitro,
    ...(cloudflareQueues ? { rollupConfig: { ...rollupConfig, external: mergeNitroExternal(rollupConfig.external, "cloudflare:workers") } } : {}),
    cloudflare: { ...cloudflare, wrangler: { ...wrangler, compatibility_flags: compatibilityFlags } },
    plugins,
  }
  if (!generated) {
    registerCloudflareProviderOutput(config, "queue", {})
    return baseNitro
  }
  const binding = queue?.provider === "cloudflare" && typeof queue.binding === "string" ? queue.binding : undefined
  if (binding && generated.producers.length > 1) {
    throw new Error("A custom Cloudflare queue binding can only be used with one Queue Definition.")
  }
  const generatedProducers = binding ? generated.producers.map(producer => ({ ...producer, binding })) : generated.producers
  registerCloudflareProviderOutput(config, "queue", {
    queues: {
      ...(cloudflareQueues ? { consumers: generated.consumers } : {}),
      producers: generatedProducers,
    },
  })
  return composeNitroCloudflareProviderOutput(config, baseNitro)
}

export function hubQueue(options?: QueueModuleOptions): QueueVitePlugin {
  let resolved: ResolvedConfig | undefined
  let queue: QueueModuleOptions | undefined = options
  let hosting = "vercel"
  let cloudflareQueues = true
  let configHookRan = false
  let nitroOwnsCloudflareWorker = false

  return {
    name: "@vite-hub/queue/vite",
    vitehub: {
      cli: async () => {
        return { namespaces: [], provision: [createQueueProvisionStep(() => resolved?.root ?? process.cwd())] }
      },
    },
    config(config) {
      queue = config.queue ?? queue
      const nitro = (config as { nitro?: unknown }).nitro
      nitroOwnsCloudflareWorker = Boolean(nitro && resolveQueueHosting(queue, cloneNitroConfig(nitro)) === "cloudflare")
      configHookRan = true
      ;(config as { nitro?: unknown }).nitro = mergeNitroConfig(config, nitro, queue, config.root || process.cwd())
    },
    async configResolved(config) {
      resolved = config
      queue = config.queue ?? queue
      const configuredNitro = (config as { nitro?: unknown }).nitro
      if (!configHookRan) {
        nitroOwnsCloudflareWorker = Boolean(configuredNitro && resolveQueueHosting(queue, cloneNitroConfig(configuredNitro)) === "cloudflare")
      }
      const nitro = mergeNitroConfig(config, configuredNitro, queue, config.root)
      ;(config as { nitro?: unknown }).nitro = nitro
      hosting = resolveQueueHosting(queue, nitro)
      cloudflareQueues = supportsCloudflareQueues(nitro)
      await writeQueueNitroIntegration(config.root, queue, hosting, cloudflareQueues)
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
      if (!/\.queue\.(?:c|m)?[jt]s$/i.test(file) && !/\/server\/queues\/.*\.(?:c|m)?[jt]s$/i.test(file)) return
      resolved = context.server.config
      await writeQueueNitroIntegration(resolved.root, queue, hosting, cloudflareQueues)
    },
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      await generateProviderOutputs({
        clientOutDir: resolved.build.outDir,
        cloudflareOwnedByNitro: nitroOwnsCloudflareWorker,
        queue: queue ?? { provider: (hosting === "cloudflare" ? "cloudflare" : "vercel") satisfies QueueProvider },
        rootDir: resolved.root,
        serverFunctionName: resolveNitroVercelFunctionName(resolved, "queue"),
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    queue?: QueueModuleOptions
  }
}
