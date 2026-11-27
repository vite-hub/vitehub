import { writeQueueTypes } from "../registry-types.ts"
import { readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"

import { defaultLocalQueueBase, normalizeQueueOptions } from "../config.ts"
import { isQueueMaxBatchSize } from "../definition.ts"
import { discoverQueueDefinitions } from "../discovery.ts"
import { getCloudflareQueueBindingName } from "../integrations/cloudflare.ts"
import { getVercelQueueTopicName } from "../integrations/vercel.ts"
import { getCloudflareQueueName } from "./cloudflare-resource-name.ts"

import type { DiscoveredQueueDefinition, QueueOptions } from "../types.ts"
import type { QueueRuntimeOptions } from "./runtime/types.ts"
import { queueErrorDiagnostics } from "../error-diagnostics.ts"

export const queuePackageName = "@vite-hub/queue"
const productName = "queue"

const generatedRegistryFileName = "registry.mjs"
export const generatedQueueTestSetup = ".vitehub/queue/test-setup.mjs"
export const generatedQueueNitroPlugin = ".vitehub/nitro/queue/plugin.ts"
export const generatedQueueNitroMiddleware = ".vitehub/nitro/queue/middleware.ts"
export const generatedQueueNitroVercelConsumerDir = ".vitehub/nitro/queue/vercel"
const vercelQueueConsumerRoutePrefix = "/api/vitehub/queues/vercel"
const packageDir = computePackageDir(import.meta.url)
const packageRequire = createRequire(resolve(packageDir, "package.json"))
const resolvePackageDependency = (specifier: string) => packageRequire.resolve(specifier)

function resolveVercelDependency(specifier: "@vercel/functions" | "@vercel/queue") {
  try {
    return packageRequire.resolve(specifier)
  }
  catch (cause) {
    throw queueErrorDiagnostics.QUEUE_VERCEL_SDK_UNAVAILABLE({ cause })
  }
}
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

export type NormalizedQueueOptions = false | NonNullable<ReturnType<typeof normalizeQueueOptions>>

export interface CloudflareQueueBindings {
  consumers: Array<{ max_batch_size?: number, queue: string }>
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

/** How the generated server reaches the app's Database, for the postgres provider. */
export interface QueueDatabaseIntegration {
  /** The module that exports the app's `databases`. Defaults to `@vite-hub/database/drizzle`. */
  import?: string
  /** The Default Database is on Postgres, as the Database integration resolved it. */
  postgres?: boolean
}

export const defaultQueueDatabaseImport = "@vite-hub/database/drizzle"

function resolveOutputQueueConfig(queue: QueueOptions | undefined, hosting: string, postgresDatabase: boolean): NormalizedQueueOptions {
  if (typeof queue === "undefined") return false
  return normalizeQueueOptions(queue, { hosting, postgresDatabase }) || false
}

function resolveRuntimeQueueConfig(queueConfig: NormalizedQueueOptions, development: boolean, rootDir: string): false | QueueRuntimeOptions {
  if (!development || queueConfig === false) return queueConfig
  if (queueConfig.driver === "local") return { ...queueConfig, development }
  return {
    base: resolve(rootDir, defaultLocalQueueBase),
    ...(queueConfig.cache === undefined ? {} : { cache: queueConfig.cache }),
    development,
    driver: "local",
    rules: queueConfig.driver,
  }
}

function createCloudflareQueueDefinitionNames(definitions: DiscoveredQueueDefinition[], namePrefix = ""): Record<string, string> {
  const names = new Map<string, DiscoveredQueueDefinition>()
  for (const definition of definitions) {
    const physicalName = getCloudflareQueueName(definition.name, namePrefix)
    const existing = names.get(physicalName)
    if (existing) {
      throw queueErrorDiagnostics.QUEUE_NAME_COLLISION({ first: existing.name, resolved: physicalName, second: definition.name })
    }
    names.set(physicalName, definition)
  }
  return Object.fromEntries([...names].map(([physicalName, definition]) => [physicalName, definition.name]))
}

/**
 * Reads `maxBatchSize` from `export default defineQueue({ ... })`. The Cloudflare consumer is configured at build time,
 * so the build fails when it cannot prove the value: a spread or computed key in those options, a value that is not a
 * number literal, or the option on a `defineQueue()` call that is not the default export.
 */
export function readQueueMaxBatchSize(file: string, { argumentExpression, defaultExportExpression, findCalls, objectProperties, scanModule }: typeof import("@vite-hub/internal/build/scan-module")): number | undefined {
  const module = scanModule(readFileSync(file, "utf8"), file)
  const invalid = (): never => {
    throw queueErrorDiagnostics.QUEUE_MAX_BATCH_SIZE_INVALID({ where: file })
  }
  const exported = defaultExportExpression(module)
  let maxBatchSize: number | undefined
  for (const call of findCalls(module, ["defineQueue"])) {
    const options = argumentExpression(call.arguments[0])
    if (options?.type !== "ObjectExpression") return invalid()
    const properties = objectProperties(options)
    if (properties.some(property => property.key === undefined || property.computed)) return invalid()
    const property = properties.findLast(candidate => candidate.key === "maxBatchSize")
    if (!property) continue
    if (call !== exported || property.node.type !== "Property" || property.node.kind !== "init" || property.node.method
      || property.value?.type !== "Literal" || !isQueueMaxBatchSize(property.value.value)) return invalid()
    maxBatchSize = property.value.value
  }
  return maxBatchSize
}

export async function createCloudflareQueueBindings(definitions: DiscoveredQueueDefinition[], namePrefix = ""): Promise<CloudflareQueueBindings | undefined> {
  if (!definitions.length) {
    return undefined
  }

  createCloudflareQueueDefinitionNames(definitions, namePrefix)
  const scanner = await import("@vite-hub/internal/build/scan-module")
  return {
    consumers: definitions.map((definition) => {
      const maxBatchSize = readQueueMaxBatchSize(definition.handler, scanner)
      return { ...(maxBatchSize === undefined ? {} : { max_batch_size: maxBatchSize }), queue: getCloudflareQueueName(definition.name, namePrefix) }
    }),
    producers: definitions.map(definition => ({
      binding: getCloudflareQueueBindingName(definition.name),
      queue: getCloudflareQueueName(definition.name, namePrefix),
    })),
  }
}

function renderNitroPlugin(pluginFile: string, registryFile: string, queueConfig: NormalizedQueueOptions, cloudflareQueues: boolean, queueDefinitions: Record<string, string>, development: boolean, databaseImport: string) {
  const cloudflareRuntime = queueConfig !== false && queueConfig.driver === "cloudflare"
  const vercelRuntime = queueConfig !== false && queueConfig.driver === "vercel"
  const localRuntime = queueConfig !== false && queueConfig.driver === "local"
  const postgresRuntime = queueConfig !== false && queueConfig.driver === "postgres"
  const postgresDatabase = queueConfig !== false && queueConfig.driver === "postgres" ? queueConfig.database : undefined
  const cloudflare = cloudflareQueues && cloudflareRuntime
  const cloudflareGlobals = cloudflareRuntime && !development
  const runtimeClientFactory = cloudflareRuntime
    ? "createCloudflareQueueRuntimeClient"
    : vercelRuntime
      ? "createVercelQueueRuntimeClient"
      : localRuntime
        ? "createLocalQueueRuntimeClient"
        : postgresRuntime
          ? "createPostgresQueueRuntimeClient"
          : undefined
  return [
    "import { definePlugin } from 'nitro'",
    ...(vercelRuntime ? [`import * as __vitehubVercelQueue from ${JSON.stringify(createImportPath(pluginFile, resolveVercelDependency("@vercel/queue")))}`] : []),
    ...(cloudflareGlobals ? ["import * as vitehubCloudflareWorkers from 'cloudflare:workers'"] : []),
    ...(cloudflare ? [`import { createQueueCloudflareWorker } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/cloudflare-vite")))}`] : []),
    ...(cloudflareRuntime ? [`import { createCloudflareQueueRuntimeClient } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/cloudflare-client")))}`] : []),
    ...(localRuntime ? [`import { closeLocalQueues, createLocalQueueRuntimeClient, startLocalQueue } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/local-client")))}`] : []),
    ...(postgresRuntime ? [`import { closePostgresQueues, createPostgresQueueRuntimeClient, startPostgresQueue } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/postgres-client")))}`] : []),
    ...(vercelRuntime ? [`import { createVercelQueueRuntimeClient } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/vercel-client")))}`] : []),
    `import { setQueueRuntimeConfig, setQueueRuntimeEventDefaults, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(pluginFile, resolveRuntimeModule("internal/runtime/state")))}`,
    `import queueRegistry from ${JSON.stringify(createImportPath(pluginFile, registryFile))}`,
    "",
    ...(cloudflareGlobals ? ["const { env: vitehubEnv, waitUntil: vitehubWaitUntil } = vitehubCloudflareWorkers as unknown as { env: Record<string, unknown>, waitUntil(promise: Promise<unknown>): void }", ""] : []),
    ...(vercelRuntime ? ["globalThis.__vitehubVercelQueue = __vitehubVercelQueue", ""] : []),
    `const queueConfig = ${JSON.stringify(queueConfig, null, 2)}`,
    ...(cloudflare ? [`const queueDefinitions = ${JSON.stringify(queueDefinitions, null, 2)}`, "const queueWorker = createQueueCloudflareWorker({ definitions: queueDefinitions, queue: queueConfig, registry: queueRegistry })"] : []),
    "",
    `export default definePlugin((${cloudflare || localRuntime || postgresRuntime ? "nitro" : ""}) => {`,
    `  setQueueRuntimeConfig(queueConfig${runtimeClientFactory ? `, ${runtimeClientFactory}` : ""})`,
    "  setQueueRuntimeRegistry(queueRegistry)",
    ...(cloudflareGlobals ? ["  setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })"] : []),
    ...(cloudflare ? ["  nitro.hooks.hook('cloudflare:queue', ({ batch, context, env }) => queueWorker.queue(batch, env, context))"] : []),
    ...(localRuntime ? ["  startLocalQueue(queueConfig)", "  nitro.hooks.hook('close', closeLocalQueues)"] : []),
    ...(postgresRuntime ? [
      postgresDatabase
        ? `  startPostgresQueue(queueConfig, () => import(${JSON.stringify(databaseImport)}).then(module => module.databases))`
        : "  startPostgresQueue(queueConfig)",
      "  nitro.hooks.hook('close', closePostgresQueues)",
    ] : []),
    "})",
    "",
  ].join("\n")
}

function renderNitroMiddleware(middlewareFile: string, queueConfig: NormalizedQueueOptions, hasDefinitions: boolean, development: boolean) {
  const cloudflare = queueConfig !== false && queueConfig.driver === "cloudflare"
  const cloudflareGlobals = cloudflare && !development
  const vercel = hasDefinitions && queueConfig !== false && queueConfig.driver === "vercel"
  return [
    "import { defineMiddleware } from 'nitro'",
    ...(vercel ? [`import { waitUntil as vitehubWaitUntil } from ${JSON.stringify(createImportPath(middlewareFile, resolveVercelDependency("@vercel/functions")))}`] : []),
    ...(cloudflareGlobals ? ["import * as vitehubCloudflareWorkers from 'cloudflare:workers'"] : []),
    `import { enterQueueRuntimeEvent } from ${JSON.stringify(createImportPath(middlewareFile, resolveRuntimeModule("internal/runtime/state")))}`,
    "",
    ...(cloudflareGlobals ? ["const { env: vitehubEnv, waitUntil: vitehubWaitUntil } = vitehubCloudflareWorkers as unknown as { env: Record<string, unknown>, waitUntil(promise: Promise<unknown>): void }", ""] : []),
    "export default defineMiddleware((event) => {",
    ...(cloudflare ? ["  const runtimeEvent = event as any"] : []),
    ...(vercel ? ["  Object.assign(event, { waitUntil: vitehubWaitUntil })"] : []),
    ...(cloudflare ? [`  Object.assign(event, { env: runtimeEvent.env ?? runtimeEvent.context?.cloudflare?.env ?? runtimeEvent.context?._platform?.cloudflare?.env ?? runtimeEvent.req?.runtime?.cloudflare?.env${cloudflareGlobals ? " ?? vitehubEnv, waitUntil: vitehubWaitUntil" : ""} })`] : []),
    "  enterQueueRuntimeEvent(event)",
    "})",
    "",
  ].join("\n")
}

/** Writes the generated Queue integration and returns the Queue config that its Nitro plugin uses. */
export async function writeQueueNitroIntegration(rootDir: string, queue: QueueOptions | undefined, hosting: string, cloudflareQueues = true, definitions: DiscoveredQueueDefinition[] = discoverQueueDefinitions({ rootDir }), development = false, importBase: string = queuePackageName, database: QueueDatabaseIntegration = {}): Promise<NormalizedQueueOptions> {
  await writeQueueTypes(rootDir, definitions, importBase)
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  const registryFile = resolve(generatedDir, generatedRegistryFileName)
  const pluginFile = resolve(rootDir, generatedQueueNitroPlugin)
  const middlewareFile = resolve(rootDir, generatedQueueNitroMiddleware)
  const queueConfig = resolveOutputQueueConfig(typeof queue === "undefined" ? {} : queue, hosting, database.postgres === true)
  const queueDefinitions = cloudflareQueues && queueConfig !== false && queueConfig.driver === "cloudflare"
    ? createCloudflareQueueDefinitionNames(definitions, queueConfig.namePrefix)
    : {}
  const runtimeConfig = resolveRuntimeQueueConfig(queueConfig, development, rootDir)
  await Promise.all([
    mkdir(dirname(pluginFile), { recursive: true }),
    mkdir(generatedDir, { recursive: true }),
  ])
  const vercelConsumerDir = resolve(rootDir, generatedQueueNitroVercelConsumerDir)
  const vercelConsumers = queueConfig !== false && queueConfig.driver === "vercel" ? createVercelQueueConsumerRoutes(definitions) : []
  await rm(vercelConsumerDir, { force: true, recursive: true })
  if (vercelConsumers.length) await mkdir(vercelConsumerDir, { recursive: true })
  await Promise.all([
    writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions), "utf8"),
    writeFile(pluginFile, renderNitroPlugin(pluginFile, registryFile, runtimeConfig, cloudflareQueues, queueDefinitions, development, database.import ?? defaultQueueDatabaseImport), "utf8"),
    writeFile(middlewareFile, renderNitroMiddleware(middlewareFile, runtimeConfig, definitions.length > 0, development), "utf8"),
    ...vercelConsumers.map(async (consumer) => {
      const file = resolve(rootDir, consumer.handler)
      await writeFile(file, renderVercelQueueConsumerHandler(file, consumer.name), "utf8")
    }),
    ...(process.env.VITEST ? [writeFile(resolve(rootDir, generatedQueueTestSetup), [
      `import { setQueueRuntimeConfig, setQueueRuntimeRegistry } from ${JSON.stringify(createImportPath(resolve(rootDir, generatedQueueTestSetup), resolveRuntimeModule("internal/runtime/state")))}`,
      `import registry from "./${generatedRegistryFileName}"`,
      `setQueueRuntimeConfig(${JSON.stringify(queueConfig)})`,
      "setQueueRuntimeRegistry(registry)",
      "",
    ].join("\n"), "utf8")] : []),
  ])
  return queueConfig
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
      throw queueErrorDiagnostics.QUEUE_NAME_COLLISION({ first: existing.name, resolved: route, second: definition.name })
    }
    routes.set(route, definition)
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
    `import { handleHostedVercelQueueCallback } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    `import { loadQueueDefinition, missingQueueDefinitionError } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("internal/runtime/state")))}`,
    "",
    `const name = ${JSON.stringify(name)}`,
    "",
    "export default {",
    "  async fetch(request) {",
    "    const definition = await loadQueueDefinition(name)",
    "    if (!definition) throw missingQueueDefinitionError(name)",
    "    return await handleHostedVercelQueueCallback(request, name, definition)",
    "  },",
    "}",
    "",
  ].join("\n")
}
