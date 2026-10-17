import { writeQueueTypes } from "../registry-types.ts"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { normalizeQueueOptions } from "../config.ts"
import { discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"
import { getCloudflareQueueName } from "./cloudflare-resource-name.ts"

import type { DiscoveredQueueDefinition, QueueModuleOptions } from "../types.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"

export const queuePackageName = "@vite-hub/queue"
const productName = "queue"

const generatedRegistryFileName = "registry.mjs"
export const generatedQueueNitroPlugin = ".vitehub/nitro/queue/plugin.ts"
export const generatedQueueNitroMiddleware = ".vitehub/nitro/queue/middleware.ts"
export const generatedQueueNitroVercelConsumerDir = ".vitehub/nitro/queue/vercel"
const vercelQueueConsumerRoutePrefix = "/api/vitehub/queues/vercel"
const packageDir = computePackageDir(import.meta.url)
const packageRequire = createRequire(resolve(packageDir, "package.json"))
const resolvePackageDependency = (specifier: string) => packageRequire.resolve(specifier)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

type NormalizedQueueOptions = false | NonNullable<ReturnType<typeof normalizeQueueOptions>>

export interface CloudflareQueueBindings {
  consumers: Array<{ queue: string }>
  producers: Array<{ binding: string, queue: string }>
}

/** One Nitro route that Vercel calls for one Queue Definition. */
export interface VercelQueueConsumerRoute {
  /** Stable Vercel consumer group name. */
  consumer: string
  /** Generated Nitro handler, relative to the project root. */
  handler: string
  name: string
  route: string
  topic: string
}

function resolveOutputQueueConfig(queue: QueueModuleOptions | undefined, hosting: string): NormalizedQueueOptions {
  if (typeof queue === "undefined") return false
  return normalizeQueueOptions(queue, { hosting }) || false
}

function createCloudflareQueueDefinitionNames(definitions: DiscoveredQueueDefinition[], namePrefix = ""): Record<string, string> {
  const names = new Map<string, DiscoveredQueueDefinition>()
  for (const definition of definitions) {
    const physicalName = getCloudflareQueueName(definition.name, namePrefix)
    const existing = names.get(physicalName)
    if (existing) {
      throw queueErrorDiagnostics.QUEUE_R0009({ message: `Queue names ${JSON.stringify(existing.name)} and ${JSON.stringify(definition.name)} collide after Cloudflare resource name derivation:\n  - ${existing.handler}\n  - ${definition.handler}\nResolved Queue name: ${physicalName}` })
    }
    names.set(physicalName, definition)
  }
  return Object.fromEntries([...names].map(([physicalName, definition]) => [physicalName, definition.name]))
}

export function createCloudflareQueueBindings(definitions: DiscoveredQueueDefinition[], namePrefix = ""): CloudflareQueueBindings | undefined {
  if (!definitions.length) {
    return undefined
  }

  const names = createCloudflareQueueDefinitionNames(definitions, namePrefix)
  return {
    consumers: Object.keys(names).map(queue => ({ queue })),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name, namePrefix),
    })),
  }
}

function renderNitroPlugin(pluginFile: string, registryFile: string, queueConfig: NormalizedQueueOptions, cloudflareQueues: boolean, queueDefinitions: Record<string, string>, development: boolean) {
  const cloudflareRuntime = queueConfig !== false && queueConfig.provider === "cloudflare"
  const vercelRuntime = queueConfig !== false && queueConfig.provider === "vercel"
  const cloudflare = cloudflareQueues && cloudflareRuntime
  const cloudflareGlobals = cloudflareRuntime && !development
  const runtimeClientFactory = cloudflareRuntime
    ? "createCloudflareQueueRuntimeClient"
    : vercelRuntime
      ? "createVercelQueueRuntimeClient"
      : undefined
  return [
    "import { definePlugin } from 'nitro'",
    ...(vercelRuntime ? [`import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(pluginFile, resolvePackageDependency("@vercel/queue")))}`] : []),
    ...(cloudflareGlobals ? ["import * as vitehubCloudflareWorkers from 'cloudflare:workers'"] : []),
    ...(cloudflare ? [`import { createQueueCloudflareWorker } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/cloudflare-vite")))}`] : []),
    ...(cloudflareRuntime ? [`import { createCloudflareQueueRuntimeClient } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/cloudflare-client")))}`] : []),
    ...(vercelRuntime ? [`import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/vercel-client")))}`] : []),
    `import { setQueueRuntimeConfig, setQueueRuntimeEventDefaults, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(pluginFile, registryFile))}`,
    "",
    ...(cloudflareGlobals ? ["const { env: vitehubEnv, waitUntil: vitehubWaitUntil } = vitehubCloudflareWorkers as unknown as { env: Record<string, unknown>, waitUntil(promise: Promise<unknown>): void }", ""] : []),
    ...(vercelRuntime ? ["globalThis.__vitehubVercelQueue = __vitehubVercelQueue", ""] : []),
    `const queueConfig = ${JSON.stringify(queueConfig, null, 2)}`,
    ...(cloudflare ? [`const queueDefinitions = ${JSON.stringify(queueDefinitions, null, 2)}`, "const queueWorker = createQueueCloudflareWorker({ definitions: queueDefinitions, queue: queueConfig, registry: queueRegistry })"] : []),
    "",
    `export default definePlugin((${cloudflare ? "nitro" : ""}) => {`,
    `  setQueueRuntimeConfig(queueConfig${runtimeClientFactory ? `, ${runtimeClientFactory}` : ""})`,
    "  setQueueRuntimeRegistry(queueRegistry)",
    ...(cloudflareGlobals ? ["  setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })"] : []),
    ...(cloudflare ? ["  nitro.hooks.hook('cloudflare:queue', ({ batch, context, env }) => queueWorker.queue(batch, env, context))"] : []),
    "})",
    "",
  ].join("\n")
}

function renderNitroMiddleware(middlewareFile: string, queueConfig: NormalizedQueueOptions, hasDefinitions: boolean, development: boolean) {
  const cloudflare = queueConfig !== false && queueConfig.provider === "cloudflare"
  const cloudflareGlobals = cloudflare && !development
  const vercel = hasDefinitions && queueConfig !== false && queueConfig.provider === "vercel"
  return [
    "import { defineMiddleware } from 'nitro'",
    ...(vercel ? [`import { waitUntil as vitehubWaitUntil } from ${JSON.stringify(createImportPath(middlewareFile, resolvePackageDependency("@vercel/functions")))}`] : []),
    ...(cloudflareGlobals ? ["import * as vitehubCloudflareWorkers from 'cloudflare:workers'"] : []),
    `import { enterQueueRuntimeEvent } from ${JSON.stringify(createImportPath(middlewareFile, resolveRuntimeModule("internal/runtime/state")))}`,
    "",
    ...(cloudflareGlobals ? ["const { env: vitehubEnv, waitUntil: vitehubWaitUntil } = vitehubCloudflareWorkers as unknown as { env: Record<string, unknown>, waitUntil(promise: Promise<unknown>): void }", ""] : []),
    "export default defineMiddleware((event) => {",
    ...(cloudflare ? ["  const runtimeEvent = event as any"] : []),
    ...(vercel ? ["  Object.assign(event, { waitUntil: vitehubWaitUntil })"] : []),
    ...(cloudflare ? [`  Object.assign(event, { env: runtimeEvent.env ?? runtimeEvent.context?.cloudflare?.env ?? runtimeEvent.context?._platform?.cloudflare?.env ?? runtimeEvent.req?.runtime?.cloudflare?.env ?? runtimeEvent.node?.req?.runtime?.cloudflare?.env${cloudflareGlobals ? " ?? vitehubEnv, waitUntil: vitehubWaitUntil" : ""} })`] : []),
    "  enterQueueRuntimeEvent(event)",
    "})",
    "",
  ].join("\n")
}

export async function writeQueueNitroIntegration(rootDir: string, queue: QueueModuleOptions | undefined, hosting: string, cloudflareQueues = true, definitions: DiscoveredQueueDefinition[] = discoverQueueDefinitions({ rootDir }), development = false, importBase: string = queuePackageName): Promise<void> {
  await writeQueueTypes(rootDir, definitions, importBase)
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const pluginFile = resolve(rootDir, generatedQueueNitroPlugin)
  const middlewareFile = resolve(rootDir, generatedQueueNitroMiddleware)
  const queueConfig = resolveOutputQueueConfig(typeof queue === "undefined" ? {} : queue, hosting)
  const queueDefinitions = cloudflareQueues && queueConfig !== false && queueConfig.provider === "cloudflare"
    ? createCloudflareQueueDefinitionNames(definitions, queueConfig.namePrefix)
    : {}
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(generatedDir, { recursive: true }),
  ])
  const vercelConsumerDir = resolve(rootDir, generatedQueueNitroVercelConsumerDir)
  const vercelConsumers = queueConfig !== false && queueConfig.provider === "vercel" ? createVercelQueueConsumerRoutes(definitions) : []
  await rm(vercelConsumerDir, { force: true, recursive: true })
  if (vercelConsumers.length) await mkdir(vercelConsumerDir, { recursive: true })
  await Promise.all([
    writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8"),
    writeFile(pluginFile, renderNitroPlugin(pluginFile, registryFile, queueConfig, cloudflareQueues, queueDefinitions, development), "utf8"),
    writeFile(middlewareFile, renderNitroMiddleware(middlewareFile, queueConfig, definitions.length > 0, development), "utf8"),
    ...vercelConsumers.map(async (consumer) => {
      const file = resolve(rootDir, consumer.handler)
      await writeFile(file, renderVercelQueueConsumerHandler(file, consumer.name), "utf8")
    }),
  ])
}

function sanitizeVercelConsumerName(functionPath: string) {
  let result = ""
  for (const char of functionPath) {
    if (char === "_") {
      result += "__"
    } else if (char === "/") {
      result += "_S"
    } else if (char === ".") {
      result += "_D"
    } else if (/[A-Za-z0-9-]/.test(char)) {
      result += char
    } else {
      result += `_${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    }
  }
  return result
}

/**
 * Maps each Queue Definition to a Nitro route with a Vercel queue trigger.
 * The consumer name keeps the function path of earlier ViteHub releases, so a redeploy keeps the Vercel consumer group.
 */
export function createVercelQueueConsumerRoutes(definitions: DiscoveredQueueDefinition[]): VercelQueueConsumerRoute[] {
  const routes = new Map<string, DiscoveredQueueDefinition>()
  return definitions.map((definition) => {
    const segments = definition.name.replace(/[^a-z0-9/_-]+/gi, "_").split("/")
    const route = `${vercelQueueConsumerRoutePrefix}/${segments.join("/")}`
    const existing = routes.get(route)
    if (existing) {
      throw queueErrorDiagnostics.QUEUE_R0010({ message: `Queue names "${existing.name}" and "${definition.name}" collide after Vercel output sanitization:\n  - ${existing.handler}\n  - ${definition.handler}\nResolved route: ${route}` })
    }
    routes.set(route, definition)
    // Nitro emits one function directory for the route, so the consumer group
    // must use that function path (without the old standalone nested segment).
    const consumer = sanitizeVercelConsumerName(`${route.slice(1)}.func`)
    return {
      consumer,
      handler: `${generatedQueueNitroVercelConsumerDir}/${consumer}.mjs`,
      name: definition.name,
      route,
      topic: getVercelQueueTopicName(definition.name),
    }
  })
}

function renderVercelQueueConsumerHandler(file: string, name: string) {
  return [
    `import { defineHandler } from ${JSON.stringify(createImportPath(file, resolvePackageDependency("h3")))}`,
    `import { handleHostedVercelQueueCallback } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    `import { loadQueueDefinition, missingQueueDefinitionError } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("internal/runtime/state")))}`,
    "",
    `const name = ${JSON.stringify(name)}`,
    "",
    "export default defineHandler(async (event) => {",
    "  const definition = await loadQueueDefinition(name)",
    "  if (!definition) throw missingQueueDefinitionError()",
    "  return await handleHostedVercelQueueCallback(event, name, definition)",
    "})",
    "",
  ].join("\n")
}
