import { createMemoryRuntimeScheduleStore } from "./store.ts"

import type { RuntimeScheduleStore, ScheduleDefinition, ScheduleDefinitionRegistry } from "../types.ts"

let runtimeRegistry: ScheduleDefinitionRegistry | undefined
let runtimeStore: RuntimeScheduleStore | undefined
const loadedRegistryEntries = new Map<string, ScheduleDefinition | undefined>()
const loadingRegistryEntries = new Map<string, Promise<ScheduleDefinition | undefined>>()

function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return Boolean(value) && typeof value === "object" && typeof (value as ScheduleDefinition).handler === "function"
}

export function setScheduleRuntimeRegistry(registry: ScheduleDefinitionRegistry | undefined): void {
  runtimeRegistry = registry
  loadedRegistryEntries.clear()
  loadingRegistryEntries.clear()
}

export function getScheduleRuntimeRegistry(): ScheduleDefinitionRegistry | undefined {
  return runtimeRegistry
}

export function setRuntimeScheduleStore(store: RuntimeScheduleStore | undefined): void {
  runtimeStore = store
}

export function getRuntimeScheduleStore(): RuntimeScheduleStore {
  return runtimeStore ??= createMemoryRuntimeScheduleStore()
}

export async function loadScheduleDefinition(name: string): Promise<ScheduleDefinition | undefined> {
  const entry = runtimeRegistry?.[name]
  if (!entry) {
    return undefined
  }

  if (loadedRegistryEntries.has(name)) {
    return loadedRegistryEntries.get(name)
  }

  const inFlightEntry = loadingRegistryEntries.get(name)
  if (inFlightEntry) {
    return await inFlightEntry
  }

  const loadingEntry = Promise.resolve().then(async () => {
    const loaded = await entry()
    if (isScheduleDefinition(loaded)) {
      return loaded
    }
    if (loaded && typeof loaded === "object" && "default" in loaded && isScheduleDefinition(loaded.default)) {
      return loaded.default
    }
    return undefined
  })
  loadingRegistryEntries.set(name, loadingEntry)
  try {
    const loaded = await loadingEntry
    loadedRegistryEntries.set(name, loaded)
    return loaded
  }
  finally {
    loadingRegistryEntries.delete(name)
  }
}

export function resetScheduleRuntime(): void {
  runtimeRegistry = undefined
  runtimeStore = undefined
  loadedRegistryEntries.clear()
  loadingRegistryEntries.clear()
}
