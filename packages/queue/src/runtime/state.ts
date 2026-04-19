import { AsyncLocalStorage } from "node:async_hooks"

import type {
  QueueClient,
  QueueDefinition,
  QueueDefinitionRegistry,
  ResolvedQueueModuleOptions,
} from "../types.ts"

let runtimeConfig: false | ResolvedQueueModuleOptions | undefined
let registryOverride: QueueDefinitionRegistry | undefined
const queueEventStorage = new AsyncLocalStorage<unknown>()
const queueClientCache = new Map<string, Promise<QueueClient>>()

export function setQueueRuntimeConfig(config: false | ResolvedQueueModuleOptions | undefined): void {
  runtimeConfig = config
  queueClientCache.clear()
}

export function getQueueRuntimeConfig(): false | ResolvedQueueModuleOptions | undefined {
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

export function getQueueClientCache(): Map<string, Promise<QueueClient>> {
  return queueClientCache
}

export function resetQueueRuntimeState(): void {
  runtimeConfig = undefined
  registryOverride = undefined
  queueClientCache.clear()
}

type QueueRegistryModule = {
  default: QueueDefinitionRegistry
}

// `#vitehub-queue-registry` resolves to `runtime/empty-registry` by default
// and is aliased by `src/nitro/module.ts` to the build-emitted registry.
async function loadRuntimeRegistry(): Promise<QueueDefinitionRegistry> {
  if (registryOverride) return registryOverride

  try {
    return (await import("#vitehub-queue-registry") as QueueRegistryModule).default || {}
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if ((error as { code?: unknown } | undefined)?.code !== "ERR_MODULE_NOT_FOUND"
      && !message.includes("#vitehub-queue-registry")) {
      throw error
    }

    return (await import(/* @vite-ignore */ ["./empty-registry", ".ts"].join("")) as QueueRegistryModule).default
  }
}

export async function loadQueueDefinition(name: string): Promise<QueueDefinition | undefined> {
  const entries = await loadRuntimeRegistry()
  const entry = entries[name]
  if (!entry) return

  const loaded = await entry()
  return "default" in loaded && loaded.default ? loaded.default : loaded as QueueDefinition
}
