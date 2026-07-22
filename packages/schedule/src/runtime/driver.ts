import { AsyncLocalStorage } from "node:async_hooks"

import { executeRuntimeScheduleWake, executeStaticSchedule } from "./execute.ts"
import { isRuntimeScheduleDue } from "./due.ts"
import {
  getRuntimeScheduleStore,
  getScheduleRunStore,
  getScheduleRuntimeRegistry,
  setRuntimeScheduleStore,
  setScheduleRunStore,
  setScheduleRuntimeRegistry,
} from "./state.ts"
import { createScheduleError } from "../errors.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleWake, ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRegistryDefinition, ScheduleRunStore } from "../types.ts"

export type { RuntimeScheduleWake } from "../types.ts"

export interface RuntimeScheduleWakeDriverContext {
  reportError(error: unknown): void
  wake(input: RuntimeScheduleWake): Promise<void>
}

export interface RuntimeScheduleWakeDriver {
  close?(): Promise<void> | void
  reconcile(schedules: readonly RuntimeScheduleRecord[]): Promise<void>
}

export type RuntimeScheduleWakeDriverFactory = (context: RuntimeScheduleWakeDriverContext) => Promise<RuntimeScheduleWakeDriver> | RuntimeScheduleWakeDriver

export interface InstallScheduleRuntimeOptions {
  createDriver: RuntimeScheduleWakeDriverFactory
  onError?: (error: unknown) => void
  registry: ScheduleDefinitionRegistry
  runtimeScheduleStore: RuntimeScheduleStore
  scheduleRunStore: ScheduleRunStore
  staticRegistry?: ScheduleDefinitionRegistry
}

export interface ScheduleRuntimeController {
  close(): Promise<void>
}

interface SerializeOperation {
  <T>(operation: () => Promise<T>): Promise<T>
  defer(operation: () => Promise<void>): void
  isReentrant(): boolean
  runWake(operation: () => Promise<void>): Promise<void>
}

interface StaticScheduleDefinitionEntry {
  definition: ScheduleDefinition
  name: string
}

interface StaticScheduleEntry extends StaticScheduleDefinitionEntry {
  record: RuntimeScheduleRecord
}

interface StaticSchedules {
  byId: Map<string, StaticScheduleEntry>
  records: RuntimeScheduleRecord[]
}

const staticScheduleIdPrefix = "\0vitehub:static:"

function isScheduleRegistryDefinition(value: unknown): value is ScheduleRegistryDefinition {
  return !!value && typeof value === "object" && "handler" in value
}

function unwrapDefinition(loaded: ScheduleRegistryDefinition | { default?: ScheduleRegistryDefinition }): ScheduleRegistryDefinition | undefined {
  if ("default" in loaded && isScheduleRegistryDefinition(loaded.default)) return loaded.default
  if (isScheduleRegistryDefinition(loaded)) return loaded
  return undefined
}

async function loadStaticDefinitions(registry: ScheduleDefinitionRegistry | undefined): Promise<StaticScheduleDefinitionEntry[]> {
  if (!registry) return []
  const definitions = await Promise.all(Object.entries(registry).map(async ([name, load]) => {
    const definition = unwrapDefinition(await load())
    return definition && "cron" in definition ? { definition, name } : undefined
  }))
  return definitions.filter((definition): definition is StaticScheduleDefinitionEntry => definition !== undefined)
}

function createStaticSchedules(definitions: readonly StaticScheduleDefinitionEntry[], runtimeSchedules: readonly RuntimeScheduleRecord[]): StaticSchedules {
  const occupiedIds = new Set(runtimeSchedules.map(schedule => schedule.id))
  const byId = new Map<string, StaticScheduleEntry>()
  const timestamp = new Date(0)
  const records = definitions.map((entry) => {
    const baseId = `${staticScheduleIdPrefix}${encodeURIComponent(entry.name)}`
    let id = baseId
    let suffix = 2
    while (occupiedIds.has(id)) id = `${baseId}:${suffix++}`
    occupiedIds.add(id)
    const record = {
      createdAt: timestamp,
      cron: entry.definition.cron,
      enabled: true,
      id,
      target: entry.name,
      updatedAt: timestamp,
    }
    byId.set(id, { ...entry, record })
    return record
  })
  return { byId, records }
}

function createSerializer(): SerializeOperation {
  let tail = Promise.resolve()
  const operationStorage = new AsyncLocalStorage<{
    active: boolean
    deferred: Array<() => Promise<void>>
    depth: number
    wakeReleases: Set<() => void>
  }>()
  const serialize = function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const activeOperation = operationStorage.getStore()
    if (activeOperation?.active) {
      return (async () => {
        activeOperation.depth++
        try {
          return await operation()
        }
        finally {
          activeOperation.depth--
        }
      })()
    }

    const operationContext = {
      active: true,
      deferred: [] as Array<() => Promise<void>>,
      depth: 0,
      wakeReleases: new Set<() => void>(),
    }
    const result = tail.then(() => operationStorage.run(operationContext, async () => {
      try {
        const value = await operation()
        while (operationContext.deferred.length > 0) {
          await operationContext.deferred.shift()!()
        }
        return value
      }
      finally {
        operationContext.active = false
      }
    }))
    tail = result.then(() => {}, () => {})
    return result
  }
  serialize.defer = (operation: () => Promise<void>) => {
    const activeOperation = operationStorage.getStore()
    if (!activeOperation?.active) {
      throw new Error("Cannot defer work outside an active serialized operation.")
    }
    activeOperation.deferred.push(operation)
    for (const release of activeOperation.wakeReleases) release()
  }
  serialize.isReentrant = () => {
    const activeOperation = operationStorage.getStore()
    return Boolean(activeOperation?.active && activeOperation.depth > 0)
  }
  serialize.runWake = async (operation: () => Promise<void>) => {
    const activeOperation = operationStorage.getStore()
    if (!activeOperation?.active) {
      await operation()
      return
    }

    let release!: () => void
    let released = false
    const releasePromise = new Promise<void>((resolve) => {
      release = () => {
        released = true
        resolve()
      }
    })
    activeOperation.wakeReleases.add(release)
    let execution: Promise<void>
    try {
      execution = Promise.resolve(operation())
    }
    catch (error) {
      execution = Promise.reject(error)
    }
    try {
      await Promise.race([execution, releasePromise])
      if (released) {
        activeOperation.deferred.push(async () => { await execution })
      }
    }
    finally {
      activeOperation.wakeReleases.delete(release)
    }
  }
  return serialize
}

function createErrorReporter(onError: InstallScheduleRuntimeOptions["onError"]): (error: unknown) => void {
  return (error) => {
    if (!onError) return
    try {
      void Promise.resolve(onError(error)).catch(() => {})
    }
    catch {}
  }
}

async function reconcileAfterMutation(
  driver: RuntimeScheduleWakeDriver,
  store: RuntimeScheduleStore,
  rollback: () => Promise<void>,
  reportError: (error: unknown) => void,
): Promise<void> {
  try {
    await driver.reconcile(await store.list())
  }
  catch (error) {
    try {
      await rollback()
    }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Runtime Schedule reconciliation failed and the stored record could not be rolled back.")
    }

    try {
      await driver.reconcile(await store.list())
    }
    catch (rollbackReconcileError) {
      reportError(rollbackReconcileError)
    }
    throw error
  }
}

function deferReentrantReconciliation(
  driver: RuntimeScheduleWakeDriver,
  store: RuntimeScheduleStore,
  rollback: () => Promise<void>,
  reportError: (error: unknown) => void,
  serialize: SerializeOperation,
): Promise<void> | undefined {
  if (!serialize.isReentrant()) return
  let rejectReconciliation!: (error: unknown) => void
  let resolveReconciliation!: () => void
  const reconciliation = new Promise<void>((resolve, reject) => {
    rejectReconciliation = reject
    resolveReconciliation = resolve
  })
  serialize.defer(async () => {
    try {
      await reconcileAfterMutation(driver, store, rollback, reportError)
      resolveReconciliation()
    }
    catch (error) {
      rejectReconciliation(error)
    }
  })
  return reconciliation
}

function createReconciledStore(
  store: RuntimeScheduleStore,
  getDriver: () => RuntimeScheduleWakeDriver,
  reportError: (error: unknown) => void,
  serialize: SerializeOperation,
): RuntimeScheduleStore {
  const runtimeScheduleStore: RuntimeScheduleStore = {
    create(record) {
      return serialize(async () => {
        const driver = getDriver()
        const created = await store.create(record)
        const rollback = async () => {
          if (!await store.delete(created.id)) {
            throw new Error(`Runtime Schedule create rollback failed: ${created.id}`)
          }
        }
        const deferred = deferReentrantReconciliation(driver, store, rollback, reportError, serialize)
        if (deferred) {
          await deferred
        }
        else {
          await reconcileAfterMutation(driver, store, rollback, reportError)
        }
        return created
      })
    },
    delete(id) {
      return serialize(async () => {
        const driver = getDriver()
        const previous = await store.get(id)
        const deleted = await store.delete(id)
        if (!deleted) return false
        const rollback = async () => {
          if (!previous) {
            throw new Error(`Runtime Schedule delete rollback failed: ${id}`)
          }
          await store.create(previous)
        }
        const deferred = deferReentrantReconciliation(driver, store, rollback, reportError, serialize)
        if (deferred) {
          await deferred
        }
        else {
          await reconcileAfterMutation(driver, store, rollback, reportError)
        }
        return true
      })
    },
    get(id) {
      return store.get(id)
    },
    list() {
      return store.list()
    },
    update(id, patch) {
      return serialize(async () => {
        const driver = getDriver()
        const previous = await store.get(id)
        const updated = await store.update(id, patch)
        if (!updated) return undefined
        const rollback = async () => {
          if (!previous) {
            if (!await store.delete(id)) {
              throw new Error(`Runtime Schedule update rollback failed: ${id}`)
            }
            return
          }
          if (!await store.delete(id)) {
            throw new Error(`Runtime Schedule update rollback failed: ${id}`)
          }
          await store.create(previous)
        }
        const deferred = deferReentrantReconciliation(driver, store, rollback, reportError, serialize)
        if (deferred) {
          await deferred
        }
        else {
          await reconcileAfterMutation(driver, store, rollback, reportError)
        }
        return updated
      })
    },
  }

  return runtimeScheduleStore
}

export async function installScheduleRuntime(options: InstallScheduleRuntimeOptions): Promise<ScheduleRuntimeController> {
  const previousRegistry = getScheduleRuntimeRegistry()
  const previousRuntimeScheduleStore = getRuntimeScheduleStore()
  const previousScheduleRunStore = getScheduleRunStore()
  const reportError = createErrorReporter(options.onError)
  const pendingWork = new Set<Promise<unknown>>()
  function waitUntil(value: PromiseLike<unknown>): void {
    const promise = Promise.resolve(value)
    pendingWork.add(promise)
    void promise.then(
      () => pendingWork.delete(promise),
      (error) => {
        pendingWork.delete(promise)
        reportError(error)
      },
    )
  }
  async function flushWaitUntil(): Promise<void> {
    while (pendingWork.size > 0) {
      await Promise.allSettled([...pendingWork])
    }
  }
  const serialize = createSerializer()
  const activeWakes = new Set<Promise<void>>()
  let driver: RuntimeScheduleWakeDriver | undefined
  let reconciledDriver: RuntimeScheduleWakeDriver | undefined
  let staticSchedules: StaticSchedules = { byId: new Map(), records: [] }
  let aborted = false
  let closing = false

  setScheduleRuntimeRegistry(options.registry)
  setScheduleRunStore(options.scheduleRunStore)

  const initializing = serialize(async () => {
    try {
      const runtimeSchedules = await options.runtimeScheduleStore.list()
      staticSchedules = createStaticSchedules(await loadStaticDefinitions(options.staticRegistry), runtimeSchedules)
      driver = await options.createDriver({
        reportError,
        wake(input) {
          if (closing) return Promise.resolve()
          const wake = serialize.runWake(async () => {
            const staticSchedule = staticSchedules.byId.get(input.scheduleId)
            if (staticSchedule) {
              if (!isRuntimeScheduleDue(staticSchedule.record, input.scheduledAt)) {
                throw createScheduleError("SCHEDULE_NOT_DUE")
              }
              await executeStaticSchedule({
                cron: staticSchedule.definition.cron,
                definition: staticSchedule.definition,
                name: staticSchedule.name,
                scheduledAt: input.scheduledAt,
                waitUntil,
              })
              return
            }
            await executeRuntimeScheduleWake(input, {
              runtimeScheduleStore: options.runtimeScheduleStore,
              scheduleRunStore: options.scheduleRunStore,
              waitUntil,
            })
          })
          activeWakes.add(wake)
          void wake.finally(() => activeWakes.delete(wake)).catch(() => {})
          return wake
        },
      })
      const installedDriver = driver
      reconciledDriver = {
        close: () => installedDriver.close?.(),
        async reconcile(records) {
          const conflictingId = records.find(record => staticSchedules.byId.has(record.id))?.id
          if (conflictingId) {
            throw new Error(`Runtime Schedule id conflicts with a Static Schedule driver identity: ${JSON.stringify(conflictingId)}`)
          }
          await installedDriver.reconcile([...staticSchedules.records, ...records])
        },
      }
      await reconciledDriver.reconcile(runtimeSchedules)
    }
    catch (error) {
      aborted = true
      throw error
    }
  })
  const runtimeScheduleStore = createReconciledStore(options.runtimeScheduleStore, () => {
    if (!reconciledDriver || aborted) {
      throw new Error("Runtime Schedule wake driver installation did not complete.")
    }
    return reconciledDriver
  }, reportError, serialize)
  setRuntimeScheduleStore(runtimeScheduleStore)

  try {
    await initializing
  }
  catch (error) {
    try {
      await driver?.close?.()
    }
    catch (closeError) {
      reportError(closeError)
    }
    setScheduleRuntimeRegistry(previousRegistry)
    setRuntimeScheduleStore(previousRuntimeScheduleStore)
    setScheduleRunStore(previousScheduleRunStore)
    throw error
  }

  if (!reconciledDriver) {
    throw new Error("Runtime Schedule wake driver installation did not produce a driver.")
  }
  const installedDriver = reconciledDriver

  let closePromise: Promise<void> | undefined
  return {
    close() {
      if (closePromise) return closePromise
      closing = true
      return closePromise = (async () => {
        while (activeWakes.size > 0) {
          await Promise.allSettled([...activeWakes])
        }
        await serialize(async () => {})
        await flushWaitUntil()
        await installedDriver.close?.()
      })()
    },
  }
}
