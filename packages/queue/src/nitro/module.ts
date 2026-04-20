import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { resolveModulePath } from "exsolve"
import type { NitroModule, NitroOptions, NitroRuntimeConfig } from "nitro/types"

import { normalizeQueueOptions } from "../config.ts"
import { createQueueRegistryContents, discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName, getCloudflareQueueName } from "../integrations/cloudflare.ts"
import { generatedDirSegments, writeNitroVercelQueueOutputs } from "../internal/nitro-build.ts"
import type { DiscoveredQueueDefinition, QueueModuleOptions, ResolvedQueueOptions } from "../types.ts"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  const fromSource = resolveModulePath(srcRelative, {
    from: import.meta.url,
    extensions: [".ts", ".mts"],
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    from: import.meta.url,
    extensions: [".js", ".mjs"],
  })
}

function createCloudflareQueueBindings(definitions: DiscoveredQueueDefinition[]) {
  if (!definitions.length) {
    return undefined
  }

  return {
    consumers: definitions.map(definition => ({ queue: getCloudflareQueueName(definition.name) })),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name),
    })),
  }
}

function mergeQueueImports(current: NitroOptions["imports"]) {
  if (current === false) {
    return current
  }

  const imports = ["defineQueue", "deferQueue", "getQueue", "runQueue"]
  const existing = current || {}
  const currentPresets = (Array.isArray(existing.presets) ? [...existing.presets] : []) as Array<{ from?: string, imports?: string[] }>
  const queuePreset = currentPresets.find(entry => entry?.from === "@vitehub/queue")

  if (queuePreset && Array.isArray(queuePreset.imports)) {
    const seen = new Set(queuePreset.imports)
    queuePreset.imports.push(...imports.filter(name => !seen.has(name)))
  } else if (!queuePreset) {
    currentPresets.push({
      from: "@vitehub/queue",
      imports,
    })
  }

  return {
    ...existing,
    presets: currentPresets,
  }
}

function createNitroQueueRegistryPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, ...generatedDirSegments, "nitro-registry.mjs")
}

async function writeNitroQueueRegistry(nitro: { options: { buildDir: string, rootDir: string, scanDirs: string[] } }) {
  const registryFile = createNitroQueueRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverQueueDefinitions({
    mode: "nitro-server-queues",
    scanDirs: nitro.options.scanDirs,
  })

  await mkdir(resolve(registryFile, ".."), { recursive: true })
  await writeFile(registryFile, createQueueRegistryContents(registryFile, definitions), "utf8")

  return {
    definitions,
    registryFile,
  }
}

const queueNitroModule: NitroModule = {
  name: "@vitehub/queue",
  async setup(nitro: any) {
    const resolved = normalizeQueueOptions(nitro.options.queue, {
      hosting: nitro.options.preset,
    })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (nitro.options.preset) runtimeConfig.hosting ||= nitro.options.preset
    runtimeConfig.queue = resolved || false

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/queue"] = resolveRuntimeEntry("../index", "@vitehub/queue")

    const { definitions, registryFile } = await writeNitroQueueRegistry(nitro)
    nitro.options.alias["#vitehub/queue/registry"] = registryFile

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeQueueImports(nitro.options.imports === false ? {} : nitro.options.imports)
    }

    if (!resolved) {
      return
    }

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/queue/runtime/nitro-plugin")
    if (!nitro.options.plugins.includes(plugin)) {
      nitro.options.plugins.push(plugin)
    }

    const queues = createCloudflareQueueBindings(definitions)
    if (queues && nitro.options.preset?.includes("cloudflare")) {
      nitro.options.cloudflare ||= {}
      nitro.options.cloudflare.wrangler ||= {}
      const existingQueues = nitro.options.cloudflare.wrangler.queues
      nitro.options.cloudflare.wrangler.queues = {
        consumers: [...(existingQueues?.consumers || [])],
        producers: [...(existingQueues?.producers || [])],
      }

      for (const consumer of queues.consumers) {
        if (!nitro.options.cloudflare.wrangler.queues.consumers?.some((existing: { queue: string }) => existing.queue === consumer.queue)) {
          nitro.options.cloudflare.wrangler.queues.consumers?.push(consumer)
        }
      }

      for (const producer of queues.producers) {
        if (!nitro.options.cloudflare.wrangler.queues.producers?.some((existing: { binding: string, queue: string }) => existing.binding === producer.binding || existing.queue === producer.queue)) {
          nitro.options.cloudflare.wrangler.queues.producers?.push(producer)
        }
      }
    }

    nitro.hooks.hook("build:before", async () => {
      const refreshed = await writeNitroQueueRegistry(nitro)
      nitro.options.alias!["#vitehub/queue/registry"] = refreshed.registryFile
    })
    nitro.hooks.hook("dev:reload", async () => {
      const refreshed = await writeNitroQueueRegistry(nitro)
      nitro.options.alias!["#vitehub/queue/registry"] = refreshed.registryFile
    })
    nitro.hooks.hook("compiled", async (currentNitro: any) => {
      if (currentNitro.options.preset?.includes("vercel")) {
        await writeNitroVercelQueueOutputs({
          outputDir: currentNitro.options.output.dir,
          queue: currentNitro.options.queue,
          registryFile,
          scanDirs: currentNitro.options.scanDirs,
        })
      }
    })
  },
}

export default queueNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    cloudflare?: {
      wrangler?: {
        queues?: {
          consumers?: Array<{ queue: string }>
          producers?: Array<{ binding: string, queue: string }>
        }
      }
    }
    queue?: QueueModuleOptions
  }

  interface NitroConfig {
    queue?: QueueModuleOptions
  }

  interface NitroRuntimeConfig {
    hosting?: string
    queue?: false | ResolvedQueueOptions
  }
}
