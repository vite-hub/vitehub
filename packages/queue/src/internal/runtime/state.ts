import { AsyncLocalStorage } from "node:async_hooks"

import { isPlainObject } from "@vite-hub/internal/object"
import { getCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { hasRuntimeType } from "@vite-hub/runtime/internal/runtime-type"

import type { QueueClient, QueueDefinition, QueueDefinitionRegistry, QueueProviderOptions, ResolvedQueueOptions } from "../../types.ts"
import { queueErrorDiagnostics } from "../../error-diagnostics.ts"

export type QueueRuntimeClientFactory = (options: QueueProviderOptions) => QueueClient | Promise<QueueClient>

let runtimeConfig: false | ResolvedQueueOptions | undefined
let runtimeClientFactory: QueueRuntimeClientFactory | undefined
let registryOverride: QueueDefinitionRegistry | undefined

const queueEventStorage = new AsyncLocalStorage<unknown>()
let queueEventDefaults: unknown
const queueClientCache = new Map<string, Promise<QueueClient>>()

export function missingQueueDefinitionError(): Error {
  return queueErrorDiagnostics.QUEUE_R0013({ message: "Missing queue definition." })
}

export function setQueueRuntimeConfig(config: false | ResolvedQueueOptions | undefined, createClient?: QueueRuntimeClientFactory): void {
  runtimeConfig = config
  runtimeClientFactory = createClient
  if (typeof config === "undefined") queueEventDefaults = undefined
  queueClientCache.clear()
}

export function getQueueRuntimeConfig(): false | ResolvedQueueOptions | undefined {
  return runtimeConfig
}

export function getQueueRuntimeClientFactory(): QueueRuntimeClientFactory | undefined {
  return runtimeClientFactory
}

export function runWithQueueRuntimeEvent<T>(event: unknown, callback: () => T): T {
  return queueEventStorage.run(event, callback)
}

export function enterQueueRuntimeEvent(event: unknown): void {
  try {
    queueEventStorage.enterWith(event)
  }
  catch {}
  const explicitEnv = event && typeof event === "object" && Object.hasOwn(event, "env")
  setActiveCloudflareEnv(explicitEnv ? (event as { env?: Record<string, unknown> }).env : getCloudflareEnv(event))
}

export function getQueueRuntimeEvent(): unknown {
  return queueEventStorage.getStore() ?? queueEventDefaults
}

export function setQueueRuntimeEventDefaults(event: unknown): void {
  queueEventDefaults = event
}

export function setQueueRuntimeRegistry(registry: QueueDefinitionRegistry | undefined): void {
  registryOverride = registry
  queueClientCache.clear()
}

export function getOrCreateQueueClient(name: string, createClient: () => Promise<QueueClient>): Promise<QueueClient> {
  const existing = queueClientCache.get(name)
  if (existing) return existing

  const pending = createClient().catch((error) => {
    // Runtime replacement can install a newer client while this creation is pending.
    if (queueClientCache.get(name) === pending) queueClientCache.delete(name)
    throw error
  })
  queueClientCache.set(name, pending)
  return pending
}

function isQueueDefinition(value: unknown): value is QueueDefinition {
  return isPlainObject(value)
    && Object.hasOwn(value, "handler")
    && hasRuntimeType(value.handler, "function")
}

export async function loadQueueDefinition(name: string): Promise<QueueDefinition | undefined> {
  const registry = registryOverride
  if (!registry || !Object.hasOwn(registry, name)) return undefined
  const entry = registry[name]
  if (!entry) {
    return undefined
  }

  const loaded = await entry()
  if (isQueueDefinition(loaded)) {
    return loaded
  }

  if (isPlainObject(loaded) && Object.hasOwn(loaded, "default") && isQueueDefinition(loaded.default)) {
    return loaded.default
  }

  return undefined
}
