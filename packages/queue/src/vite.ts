import { getViteMode } from "@vite-hub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"

import { createCloudflareQueueBindings, generateProviderOutputs, generatedQueueNitroPlugin, queuePackageName, writeQueueNitroIntegration } from "./internal/vite-build.ts"
import { discoverQueueDefinitions } from "./discovery.ts"
import { createQueueProvisionStep } from "./provision.ts"

import type { QueueModuleOptions } from "./types.ts"
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

function resolveQueueHosting(queue: QueueModuleOptions | undefined, nitro: Record<string, unknown>): string {
  if (queue !== false && queue?.provider) return queue.provider
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
  return getHostingProvider(preset) || "vercel"
}

function supportsCloudflareQueues(nitro: Record<string, unknown>): boolean {
  const preset = typeof nitro.preset === "string" ? nitro.preset : process.env.NITRO_PRESET || process.env.SERVER_PRESET || ""
  return !preset.includes("cloudflare_pages")
}

function mergeNitroConfig(value: unknown, queue: QueueModuleOptions | undefined, root: string): Record<string, unknown> {
  const nitro = cloneNitroConfig(value)
  const plugins = Array.isArray(nitro.plugins) ? [...nitro.plugins] : []
  if (!plugins.includes(generatedQueueNitroPlugin)) plugins.push(generatedQueueNitroPlugin)
  if (typeof queue === "undefined" || queue === false || resolveQueueHosting(queue, nitro) !== "cloudflare" || !supportsCloudflareQueues(nitro)) return { ...nitro, plugins }
  const cloudflare = cloneNitroConfig(nitro.cloudflare)
  const wrangler = cloneNitroConfig(cloudflare.wrangler)
  const generated = createCloudflareQueueBindings(discoverQueueDefinitions({ rootDir: root }))
  if (!generated) return { ...nitro, plugins }
  const binding = queue.provider === "cloudflare" && typeof queue.binding === "string" ? queue.binding : undefined
  const generatedProducers = binding ? generated.producers.slice(0, 1).map(producer => ({ ...producer, binding })) : generated.producers
  const queues = cloneNitroConfig(wrangler.queues)
  const consumers = Array.isArray(queues.consumers) ? queues.consumers : []
  const producers = Array.isArray(queues.producers) ? queues.producers : []
  return {
    ...nitro,
    cloudflare: {
      ...cloudflare,
      wrangler: {
        ...wrangler,
        queues: {
          ...queues,
          consumers: [...consumers, ...generated.consumers.filter(entry => !consumers.some(current => cloneNitroConfig(current).queue === entry.queue))],
          producers: [...producers, ...generatedProducers.filter(entry => !producers.some(current => cloneNitroConfig(current).binding === entry.binding))],
        },
      },
    },
    plugins,
  }
}

export function hubQueue(options?: QueueModuleOptions): QueueVitePlugin {
  let resolved: ResolvedConfig | undefined
  let queue: QueueModuleOptions | undefined = options

  return {
    name: "@vite-hub/queue/vite",
    vitehub: {
      cli: async () => {
        return { namespaces: [], provision: [createQueueProvisionStep(() => resolved?.root ?? process.cwd())] }
      },
    },
    config(config) {
      queue = config.queue ?? queue
      const nitro = mergeNitroConfig((config as { nitro?: unknown }).nitro, queue, config.root || process.cwd())
      return { nitro } as never
    },
    async configResolved(config) {
      resolved = config
      queue = config.queue ?? queue
      const nitro = cloneNitroConfig((config as { nitro?: unknown }).nitro)
      await writeQueueNitroIntegration(config.root, queue, resolveQueueHosting(queue, nitro), supportsCloudflareQueues(nitro))
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }
      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    async closeBundle() {
      if (!resolved || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }
      await generateProviderOutputs({
        clientOutDir: resolved.build.outDir,
        queue,
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
