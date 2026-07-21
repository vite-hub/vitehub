import { AsyncLocalStorage } from "node:async_hooks"

import { getCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import type { QueueClient, QueueDefinition, QueueDefinitionRegistry, QueueProviderOptions, ResolvedQueueOptions } from "../types.ts"

export type QueueRuntimeClientFactory = (options: QueueProviderOptions) => QueueClient | Promise<QueueClient>

let runtimeConfig: false | ResolvedQueueOptions | undefined
let runtimeClientFactory: QueueRuntimeClientFactory | undefined
let registryOverride: QueueDefinitionRegistry | undefined

const queueEventStorage = new AsyncLocalStorage<unknown>()
let queueEventDefaults: unknown
const queueClientCache = new Map<string, Promise<unknown>>()

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
  setActiveCloudflareEnv(getCloudflareEnv(event))
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

export function getQueueClientCache(): Map<string, Promise<unknown>> {
  return queueClientCache
}

function isQueueDefinition(value: unknown): value is QueueDefinition {
  return Boolean(value) && typeof value === "object" && typeof (value as QueueDefinition).handler === "function"
}

export async function loadQueueDefinition(name: string): Promise<QueueDefinition | undefined> {
  const entry = registryOverride?.[name]
  if (!entry) {
    return undefined
  }

  const loaded = await entry()
  if (isQueueDefinition(loaded)) {
    return loaded
  }

  if (loaded && typeof loaded === "object" && "default" in loaded && isQueueDefinition(loaded.default)) {
    return loaded.default
  }

  return undefined
}
