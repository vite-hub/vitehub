import { AsyncLocalStorage } from "node:async_hooks"

import { createMemoryRuntimeScheduleStore } from "./store.ts"

import type { RuntimeScheduleStore, ScheduleDefinition, ScheduleDefinitionRegistry } from "../types.ts"

let runtimeRegistry: ScheduleDefinitionRegistry | undefined
let runtimeStore: RuntimeScheduleStore | undefined
let runtimeRegistryVersion = 0
let fallbackEvent: unknown
const eventStorage = new AsyncLocalStorage<unknown>()
const loadedRegistryEntries = new Map<string, ScheduleDefinition | undefined>()
const loadingRegistryEntries = new Map<string, Promise<ScheduleDefinition | undefined>>()
const loadingRegistryStorage = new AsyncLocalStorage<Set<string>>()

function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return Boolean(value) && typeof value === "object" && typeof (value as ScheduleDefinition).handler === "function"
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

export function enterScheduleRuntimeEvent(event: unknown): void {
  fallbackEvent = event
  try {
    eventStorage.enterWith(event)
  }
  catch {}
}

export function getScheduleRuntimeEvent(): unknown {
  return eventStorage.getStore() ?? fallbackEvent
}

export async function runWithScheduleRuntimeEvent<T>(event: unknown, run: () => T | Promise<T>): Promise<T> {
  return await eventStorage.run(event, run)
}

export async function loadScheduleDefinition(name: string): Promise<ScheduleDefinition | undefined> {
  const entry = runtimeRegistry?.[name]
  if (!entry) {
    return undefined
  }

  if (loadedRegistryEntries.has(name)) {
    return loadedRegistryEntries.get(name)
  }

  const activeLoads = loadingRegistryStorage.getStore()
  const inFlightEntry = loadingRegistryEntries.get(name)
  if (inFlightEntry) {
    return activeLoads?.has(name) ? undefined : await inFlightEntry
  }

  const nextActiveLoads = new Set(activeLoads)
  nextActiveLoads.add(name)
  const loadingVersion = runtimeRegistryVersion
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
  loadingRegistryEntries.set(name, loadingEntry)
  try {
    const loaded = await loadingEntry
    if (loadingVersion === runtimeRegistryVersion) {
      loadedRegistryEntries.set(name, loaded)
    }
    return loaded
  }
  finally {
    loadingRegistryEntries.delete(name)
  }
}

export function resetScheduleRuntime(): void {
  runtimeRegistry = undefined
  runtimeRegistryVersion++
  runtimeStore = undefined
  fallbackEvent = undefined
  loadedRegistryEntries.clear()
  loadingRegistryEntries.clear()
}
