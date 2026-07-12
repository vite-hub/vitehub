import { AsyncLocalStorage } from "node:async_hooks"

import { createMemoryRuntimeScheduleStore, createMemoryScheduleRunStore } from "./store.ts"

import type { RuntimeScheduleStore, ScheduleDefinitionRegistry, ScheduleRegistryDefinition, ScheduleRunStore } from "../types.ts"

let runtimeRegistry: ScheduleDefinitionRegistry | undefined
let runtimeStore: RuntimeScheduleStore | undefined
let runtimeRegistryVersion = 0
let runStore: ScheduleRunStore | undefined
const loadedRegistryEntries = new Map<string, ScheduleRegistryDefinition | undefined>()
const loadingRegistryEntries = new Map<string, {
  promise: Promise<ScheduleRegistryDefinition | undefined>
  version: number
}>()
const loadingRegistryStorage = new AsyncLocalStorage<Set<string>>()

function isScheduleDefinition(value: unknown): value is ScheduleRegistryDefinition {
  return Boolean(value) && typeof value === "object" && typeof (value as ScheduleRegistryDefinition).handler === "function"
}

export function setScheduleRuntimeRegistry(registry: ScheduleDefinitionRegistry | undefined): void {
  runtimeRegistry = registry
  runtimeRegistryVersion++
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

export function setScheduleRunStore(store: ScheduleRunStore | undefined): void {
  runStore = store
}

export function getScheduleRunStore(): ScheduleRunStore {
  return runStore ??= createMemoryScheduleRunStore()
}

export async function loadScheduleDefinition(name: string): Promise<ScheduleRegistryDefinition | undefined> {
  const entry = runtimeRegistry && Object.hasOwn(runtimeRegistry, name) ? runtimeRegistry[name] : undefined
  if (typeof entry !== "function") {
    return undefined
  }

  if (loadedRegistryEntries.has(name)) {
    return loadedRegistryEntries.get(name)
  }

  const activeLoads = loadingRegistryStorage.getStore()
  const inFlightEntry = loadingRegistryEntries.get(name)
  if (inFlightEntry) {
    if (activeLoads?.has(name)) return undefined
    const loaded = await inFlightEntry.promise
    return inFlightEntry.version === runtimeRegistryVersion ? loaded : undefined
  }

  const loadingVersion = runtimeRegistryVersion
  const nextActiveLoads = new Set(activeLoads)
  nextActiveLoads.add(name)
  const loadingEntry = Promise.resolve().then(() => loadingRegistryStorage.run(nextActiveLoads, async () => {
    const loaded = await entry()
    if (isScheduleDefinition(loaded)) {
      return loaded
    }
    if (loaded && typeof loaded === "object" && "default" in loaded && isScheduleDefinition(loaded.default)) {
      return loaded.default
    }
    return undefined
  }))
  loadingRegistryEntries.set(name, { promise: loadingEntry, version: loadingVersion })
  try {
    const loaded = await loadingEntry
    if (loadingVersion === runtimeRegistryVersion) {
      loadedRegistryEntries.set(name, loaded)
      return loaded
    }
    return undefined
  }
  finally {
    if (loadingRegistryEntries.get(name)?.promise === loadingEntry) {
      loadingRegistryEntries.delete(name)
    }
  }
}

export function resetScheduleRuntime(): void {
  runtimeRegistry = undefined
  runtimeRegistryVersion++
  runtimeStore = undefined
  runStore = undefined
  loadedRegistryEntries.clear()
  loadingRegistryEntries.clear()
}
