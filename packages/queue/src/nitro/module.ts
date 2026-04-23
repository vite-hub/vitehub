import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"
import type { NitroModule, NitroOptions, NitroRuntimeConfig } from "nitro/types"

import { normalizeQueueOptions } from "../config.ts"
import { createQueueRegistryContents, discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName, getCloudflareQueueName } from "../integrations/cloudflare.ts"
import { generatedDirSegments, writeNitroVercelQueueOutputs } from "../internal/nitro-build.ts"
import type { DiscoveredQueueDefinition, QueueModuleOptions, ResolvedQueueOptions } from "../types.ts"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
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

function createNitroQueuePluginPath(rootDir: string, buildDir: string) {
  return resolve(rootDir, buildDir, ...generatedDirSegments, "nitro-plugin.ts")
}

function resolveNitroQueueScanDirs(rootDir: string, scanDirs: string[] | undefined) {
  return scanDirs?.length ? scanDirs : [resolve(rootDir, "server")]
}

function createNitroQueuePluginContents(file: string, registryFile: string) {
  return [
    "import { definePlugin as defineNitroPlugin } from \"nitro\"",
    "import { useRuntimeConfig } from \"nitro/runtime-config\"",
    "",
    "import { createCloudflareQueueBatchHandler, getCloudflareQueueDefinitionName, type CloudflareQueueMessageBatch, type ResolvedQueueOptions } from \"@vitehub/queue\"",
    "import { enterQueueRuntimeEvent, loadQueueDefinition, runWithQueueRuntimeEvent, setQueueRuntimeConfig, setQueueRuntimeRegistry } from \"@vitehub/queue/runtime/state\"",
    "",
    `import queueRegistry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    "",
    "function setActiveCloudflareEnv(env: Record<string, unknown>): void {",
    "  ;(globalThis as { __env__?: Record<string, unknown> }).__env__ = env",
    "}",
    "",
    "function createCloudflareRuntimeEvent(env: Record<string, unknown>, context: { waitUntil?: (promise: Promise<unknown>) => void } | undefined) {",
    "  const waitUntil = typeof context?.waitUntil === \"function\" ? context.waitUntil.bind(context) : undefined",
    "  return {",
    "    context: { cloudflare: { context, env }, waitUntil },",
    "    env,",
    "    waitUntil,",
    "  }",
    "}",
    "",
    "function createQueueJob(message: CloudflareQueueMessageBatch[\"messages\"][number], batch: CloudflareQueueMessageBatch) {",
    "  return {",
    "    attempts: typeof message.attempts === \"number\" ? message.attempts : 1,",
    "    id: message.id,",
    "    metadata: { batch, message },",
    "    payload: message.body,",
    "  }",
    "}",
    "",
    "const queueNitroPlugin: ReturnType<typeof defineNitroPlugin> = defineNitroPlugin((nitroApp: any) => {",
    "  const runtimeConfig = useRuntimeConfig() as {",
    "    queue?: false | ResolvedQueueOptions",
    "  }",
    "",
    "  const applyRuntimeState = () => {",
    "    setQueueRuntimeConfig(runtimeConfig.queue)",
    "    setQueueRuntimeRegistry(queueRegistry)",
    "  }",
    "",
    "  applyRuntimeState()",
    "",
    "  nitroApp.hooks.hook(\"request\", (event: any) => {",
    "    applyRuntimeState()",
    "    enterQueueRuntimeEvent(event)",
    "  })",
    "",
    "  nitroApp.hooks.hook(\"cloudflare:queue\", async ({ batch, env, context }: { batch: CloudflareQueueMessageBatch, context: { waitUntil?: (promise: Promise<unknown>) => void }, env: Record<string, unknown> }) => {",
    "    applyRuntimeState()",
    "    if (runtimeConfig.queue === false || runtimeConfig.queue?.provider !== \"cloudflare\") {",
    "      return",
    "    }",
    "",
    "    setActiveCloudflareEnv(env as Record<string, unknown>)",
    "    const definition = await loadQueueDefinition(getCloudflareQueueDefinitionName(batch.queue))",
    "    if (!definition) {",
    "      return",
    "    }",
    "",
    "    const runtimeEvent = createCloudflareRuntimeEvent(env as Record<string, unknown>, context)",
    "    await createCloudflareQueueBatchHandler({",
    "      concurrency: definition.options?.concurrency,",
    "      onError: definition.options?.onError,",
    "      onMessage: async (message, currentBatch) => {",
    "        await runWithQueueRuntimeEvent(runtimeEvent, async () => {",
    "          await definition.handler(createQueueJob(message, currentBatch))",
    "        })",
    "      },",
    "    })(batch as CloudflareQueueMessageBatch)",
    "  })",
    "})",
    "",
    "export default queueNitroPlugin",
    "",
  ].join("\n")
}

async function writeNitroQueueRuntimeFiles(nitro: { options: { buildDir: string, rootDir: string, scanDirs: string[] } }) {
  const registryFile = createNitroQueueRegistryPath(nitro.options.rootDir, nitro.options.buildDir)
  const pluginFile = createNitroQueuePluginPath(nitro.options.rootDir, nitro.options.buildDir)
  const definitions = discoverQueueDefinitions({
    mode: "nitro-server-queues",
    scanDirs: resolveNitroQueueScanDirs(nitro.options.rootDir, nitro.options.scanDirs),
  })

  await mkdir(resolve(registryFile, ".."), { recursive: true })
  const registryContents = createQueueRegistryContents(registryFile, definitions)
  const pluginContents = createNitroQueuePluginContents(pluginFile, registryFile)
  const writeGeneratedFile = async (file: string, contents: string) => {
    const existing = await readFile(file, "utf8").catch(() => undefined)
    if (existing === contents) {
      return
    }

    await writeFile(file, contents, "utf8")
  }

  await writeGeneratedFile(registryFile, registryContents)
  await writeGeneratedFile(pluginFile, pluginContents)

  return {
    definitions,
    pluginFile,
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
    nitro.options.alias["@vitehub/queue/runtime/state"] = resolveRuntimeEntry("../runtime/state", "@vitehub/queue/runtime/state")

    let runtimeFiles = await writeNitroQueueRuntimeFiles(nitro)
    nitro.options.alias["#vitehub/queue/registry"] = runtimeFiles.registryFile
    const { definitions } = runtimeFiles

    const importsExplicitlyDisabled = nitro.options._config?.imports === false
    if (!importsExplicitlyDisabled) {
      nitro.options.imports = mergeQueueImports(nitro.options.imports === false ? {} : nitro.options.imports)
    }

    if (!resolved) {
      return
    }

    nitro.options.plugins ||= []
    const plugin = runtimeFiles.pluginFile
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
      runtimeFiles = await writeNitroQueueRuntimeFiles(nitro)
    })
    nitro.hooks.hook("dev:reload", async () => {
      runtimeFiles = await writeNitroQueueRuntimeFiles(nitro)
    })
    nitro.hooks.hook("compiled", async (currentNitro: any) => {
      if (currentNitro.options.preset?.includes("vercel")) {
        await writeNitroVercelQueueOutputs({
          outputDir: currentNitro.options.output.dir,
          queue: currentNitro.options.queue,
          registryFile: runtimeFiles.registryFile,
          scanDirs: resolveNitroQueueScanDirs(currentNitro.options.rootDir, currentNitro.options.scanDirs),
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
