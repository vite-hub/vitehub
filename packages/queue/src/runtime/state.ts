import type {
  QueueClient,
  QueueDefinition,
  QueueDefinitionRegistry,
  ResolvedQueueModuleOptions,
} from "../types.ts"

type QueueRuntimeEventStorage = {
  getStore: () => unknown
  run: <T>(event: unknown, callback: () => T) => T
}

let runtimeConfig: false | ResolvedQueueModuleOptions | undefined
let runtimeEventFallback: unknown
let runtimeEventStorage: false | QueueRuntimeEventStorage | undefined
let registryOverride: QueueDefinitionRegistry | undefined
const queueClientCache = new Map<string, Promise<QueueClient>>()

export function setQueueRuntimeConfig(config: false | ResolvedQueueModuleOptions | undefined): void {
  runtimeConfig = config
  queueClientCache.clear()
}

export function getQueueRuntimeConfig(): false | ResolvedQueueModuleOptions | undefined {
  return runtimeConfig
}

async function getRuntimeEventStorage(): Promise<false | QueueRuntimeEventStorage> {
  if (typeof runtimeEventStorage !== "undefined") return runtimeEventStorage

  try {
    const { AsyncLocalStorage } = await import("node:async_hooks")
    runtimeEventStorage = new AsyncLocalStorage<unknown>()
  }
  catch {
    runtimeEventStorage = false
  }
  return runtimeEventStorage
}

export async function runWithQueueRuntimeEvent<T>(
  event: unknown,
  callback: () => T | Promise<T>,
): Promise<T> {
  const storage = await getRuntimeEventStorage()
  if (storage) return await storage.run(event, callback)

  const previous = runtimeEventFallback
  runtimeEventFallback = event
  try {
    return await callback()
  }
  finally {
    runtimeEventFallback = previous
  }
}

export function getQueueRuntimeEvent(): unknown {
  return runtimeEventStorage ? runtimeEventStorage.getStore() : runtimeEventFallback
}

export function setQueueRuntimeRegistry(registry: QueueDefinitionRegistry | undefined): void {
  registryOverride = registry
  queueClientCache.clear()
}

export function getQueueClientCache(): Map<string, Promise<QueueClient>> {
  return queueClientCache
}

export function resetQueueRuntimeState(): void {
  runtimeConfig = undefined
  runtimeEventFallback = undefined
  registryOverride = undefined
  queueClientCache.clear()
}

async function loadRuntimeRegistry(): Promise<QueueDefinitionRegistry> {
  if (registryOverride) return registryOverride

  try {
    const loaded = await import("#vitehub-queue-registry") as { default?: QueueDefinitionRegistry }
    return loaded.default || {}
  }
  catch {
    return {}
  }
}

export async function loadQueueDefinition(name: string): Promise<QueueDefinition | undefined> {
  const entries = await loadRuntimeRegistry()
  const entry = entries[name]
  if (!entry) return

  const loaded = await entry()
  return "default" in loaded && loaded.default ? loaded.default : loaded as QueueDefinition
}
