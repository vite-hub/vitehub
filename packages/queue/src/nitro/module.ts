import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { resolveModulePath } from "exsolve"
import type { NitroEventHandler, NitroModule, NitroRuntimeConfig } from "nitro/types"

import { normalizeQueueOptions } from "../config.ts"
import { createQueueRegistryContents, discoverQueueDefinitions } from "../discovery.ts"
import { configureCloudflareQueues } from "../integrations/cloudflare.ts"
import { setupVercelQueueBuildOutputSupport } from "../integrations/vercel.ts"
import type { DiscoveredQueueDefinition, QueueModuleOptions, ResolvedQueueModuleOptions } from "../types.ts"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  const fromSource = resolveModulePath(srcRelative, {
    extensions: [".ts", ".mts"],
    from: import.meta.url,
    try: true,
  })
  return fromSource ?? resolveModulePath(packageSubpath, {
    extensions: [".js", ".mjs"],
    from: import.meta.url,
  })
}

function toSafeFileSegment(name: string): string {
  return name
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("__") || "index"
}

function createHostedHandlerContents(name: string): string {
  return [
    "import { defineEventHandler } from \"h3\"",
    "import { handleHostedVercelQueueCallback } from \"@vitehub/queue/runtime/hosted\"",
    "",
    "export default defineEventHandler(async (event) => {",
    `  const mod = await import(${JSON.stringify(`#vitehub-queue-definition/${name}`)})`,
    "  const definition = mod.default || mod",
    `  return await handleHostedVercelQueueCallback(event, ${JSON.stringify(name)}, definition)`,
    "})",
    "",
  ].join("\n")
}

function writeQueueRuntimeFiles(buildDir: string, definitions: DiscoveredQueueDefinition[]) {
  const queueBuildDir = resolve(buildDir, "vitehub", "queue")
  mkdirSync(queueBuildDir, { recursive: true })

  const registryFile = resolve(queueBuildDir, "registry.mjs")
  writeFileSync(registryFile, createQueueRegistryContents(registryFile, definitions), "utf8")

  const hostedHandlers = new Map<string, string>()
  for (const definition of definitions) {
    const hostedFile = resolve(queueBuildDir, `vercel-${toSafeFileSegment(definition.name)}.mjs`)
    writeFileSync(hostedFile, createHostedHandlerContents(definition.name), "utf8")
    hostedHandlers.set(definition.name, hostedFile)
  }

  return { hostedHandlers, registryFile }
}

function pushUniqueHandler(handlers: NitroEventHandler[], handler: NitroEventHandler) {
  if (!handlers.some(entry => entry.route === handler.route && entry.method === handler.method)) {
    handlers.push(handler)
  }
}

const queueNitroModule: NitroModule = {
  name: "@vitehub/queue",
  setup(nitro) {
    const hosting = (nitro.options.preset || process.env.NITRO_PRESET || "").trim() || undefined
    const resolved = normalizeQueueOptions(nitro.options.queue, { hosting })
    const runtimeConfig = (nitro.options.runtimeConfig ||= {} as NitroRuntimeConfig)
    if (hosting) runtimeConfig.hosting ||= hosting
    runtimeConfig.queue = resolved ?? false

    if (!resolved) return

    const definitions = discoverQueueDefinitions(nitro.options)
    const { hostedHandlers, registryFile } = writeQueueRuntimeFiles(nitro.options.buildDir, definitions)
    nitro.hooks.hook("build:before", () => {
      writeQueueRuntimeFiles(nitro.options.buildDir, definitions)
    })

    nitro.options.alias ||= {}
    nitro.options.alias["@vitehub/queue"] = resolveRuntimeEntry("../index", "@vitehub/queue")
    nitro.options.alias["@vitehub/queue/runtime/hosted"] = resolveRuntimeEntry("../runtime/hosted", "@vitehub/queue/runtime/hosted")
    nitro.options.alias["#vitehub-queue-registry"] = registryFile
    for (const definition of definitions) {
      nitro.options.alias[`#vitehub-queue-definition/${definition.name}`] = definition.handler
    }

    nitro.options.plugins ||= []
    const plugin = resolveRuntimeEntry("../runtime/nitro-plugin", "@vitehub/queue/runtime/nitro-plugin")
    if (!nitro.options.plugins.includes(plugin)) nitro.options.plugins.push(plugin)

    nitro.options.handlers ||= []
    for (const definition of definitions) {
      const handler = hostedHandlers.get(definition.name)
      if (!handler) continue
      pushUniqueHandler(nitro.options.handlers, {
        handler,
        method: "POST",
        route: `/_vitehub/queues/vercel/${definition.name}`,
      })
    }

    configureCloudflareQueues(nitro.options, definitions, resolved.provider)
    setupVercelQueueBuildOutputSupport(nitro, nitro.options.queue, definitions)
  },
}

export default queueNitroModule

declare module "nitro/types" {
  interface NitroOptions {
    cloudflare?: {
      wrangler?: {
        queues?: {
          consumers?: Array<Record<string, unknown>>
          producers?: Array<Record<string, unknown>>
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
    queue?: false | ResolvedQueueModuleOptions
  }
}
