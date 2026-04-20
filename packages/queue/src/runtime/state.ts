import { AsyncLocalStorage } from "node:async_hooks"

import type { QueueDefinition, QueueDefinitionRegistry, ResolvedQueueOptions } from "../types.ts"

let runtimeConfig: false | ResolvedQueueOptions | undefined
let registryOverride: QueueDefinitionRegistry | undefined

const queueEventStorage = new AsyncLocalStorage<unknown>()
const queueClientCache = new Map<string, Promise<unknown>>()

export function setQueueRuntimeConfig(config: false | ResolvedQueueOptions | undefined): void {
  runtimeConfig = config
  queueClientCache.clear()
}

export function getQueueRuntimeConfig(): false | ResolvedQueueOptions | undefined {
  return runtimeConfig
}

export function runWithQueueRuntimeEvent<T>(event: unknown, callback: () => T): T {
  return queueEventStorage.run(event, callback)
}

export function enterQueueRuntimeEvent(event: unknown): void {
  queueEventStorage.enterWith(event)
}

export function getQueueRuntimeEvent(): unknown {
  return queueEventStorage.getStore()
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
