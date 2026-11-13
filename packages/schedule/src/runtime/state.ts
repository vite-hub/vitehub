import { AsyncLocalStorage } from "node:async_hooks"

import { createMemoryScheduleRunStore } from "./store.ts"
import { isRecordOrFunction as isObjectRecord } from "@vite-hub/internal/object"

import type { OccurrenceClaims } from "./claims.ts"
import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRegistryDefinition, ScheduleRunStore, StartedScheduleStore } from "../types.ts"

/** The cron and time zone of a Schedule that the Process Runtime runs. */
type ProcessScheduleTimingRecord = Pick<ScheduleDefinition, "cron" | "timeZone">

/** What `startSchedule()` and the started-Schedule tick use. The generated Nitro plugin installs it. */
export interface StartedScheduleRuntime {
  /** How far back the first tick after a start runs cron minutes that no tick checked. */
  catchUpMs: number
  /** Last minute, in epoch milliseconds, that a tick of this process checked. */
  checkedThrough?: number
  /** Occurrences that another process held at a tick, by run id. The next tick tries them again. */
  held?: Map<string, { scheduledAt: Date, scheduleId: string }>
  /** Schedule Definitions without `cron`, by name. */
  registry: ScheduleDefinitionRegistry
  store: StartedScheduleStore
}

let runtimeRegistry: ScheduleDefinitionRegistry | undefined
const processDefinitions = new Set<ReadonlyMap<string, ProcessScheduleTimingRecord>>()
let runtimeRegistryVersion = 0
let runStore: ScheduleRunStore | undefined
let startedRuntime: StartedScheduleRuntime | undefined
let occurrenceClaims: OccurrenceClaims | undefined
const loadedRegistryEntries = new Map<string, ScheduleRegistryDefinition | undefined>()
const loadingRegistryEntries = new Map<string, {
  promise: Promise<ScheduleRegistryDefinition | undefined>
  version: number
}>()
const loadingRegistryStorage = new AsyncLocalStorage<Set<string>>()

function isScheduleDefinition(value: unknown): value is ScheduleRegistryDefinition {
  return isObjectRecord(value)
    && Object.hasOwn(value, "handler")
    && typeof Reflect.get(value, "handler") === "function"
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

/** Publish only ready runtimes, retaining earlier snapshots until their controllers close. */
export function registerProcessScheduleDefinitions(definitions: ReadonlyMap<string, ProcessScheduleTimingRecord>): () => void {
  processDefinitions.add(definitions)
  return () => { processDefinitions.delete(definitions) }
}

export function getProcessScheduleDefinitions(): ReadonlyMap<string, ProcessScheduleTimingRecord> | undefined {
  return [...processDefinitions].at(-1)
}

export function setScheduleRunStore(store: ScheduleRunStore | undefined): void {
  runStore = store
}

export function getScheduleRunStore(): ScheduleRunStore {
  return runStore ??= createMemoryScheduleRunStore()
}

/** Installs the claims that make each occurrence run in one process only. The Process Runtime installs them. */
export function setScheduleOccurrenceClaims(claims: OccurrenceClaims | undefined): void {
  occurrenceClaims = claims
}

export function getScheduleOccurrenceClaims(): OccurrenceClaims | undefined {
  return occurrenceClaims
}

export function setStartedScheduleRuntime(runtime: StartedScheduleRuntime | undefined): void {
  startedRuntime = runtime
}

export function getStartedScheduleRuntime(): StartedScheduleRuntime | undefined {
  return startedRuntime
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
    if (isObjectRecord(loaded) && Object.hasOwn(loaded, "default")) {
      const definition = Reflect.get(loaded, "default")
      if (isScheduleDefinition(definition)) return definition
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
  processDefinitions.clear()
  runtimeRegistryVersion++
  runStore = undefined
  startedRuntime = undefined
  occurrenceClaims = undefined
  loadedRegistryEntries.clear()
  loadingRegistryEntries.clear()
}
