import { AsyncLocalStorage } from "node:async_hooks"

import { executeRuntimeScheduleWake } from "./execute.ts"
import {
  getRuntimeScheduleStore,
  getScheduleRunStore,
  getScheduleRuntimeRegistry,
  setRuntimeScheduleStore,
  setScheduleRunStore,
  setScheduleRuntimeRegistry,
} from "./state.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleWake, ScheduleDefinitionRegistry, ScheduleRunStore } from "../types.ts"

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
}

export interface ScheduleRuntimeController {
  close(): Promise<void>
}

interface SerializeOperation {
  <T>(operation: () => Promise<T>): Promise<T>
  defer(operation: () => Promise<void>): void
  isReentrant(): boolean
}

function createSerializer(): SerializeOperation {
  let tail = Promise.resolve()
  const operationStorage = new AsyncLocalStorage<{
    active: boolean
    deferred: Array<() => Promise<void>>
    depth: number
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

    const operationContext = { active: true, deferred: [] as Array<() => Promise<void>>, depth: 0 }
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
  }
  serialize.isReentrant = () => {
    const activeOperation = operationStorage.getStore()
    return Boolean(activeOperation?.active && activeOperation.depth > 0)
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
  reportError: (error: unknown) => void,
  serialize: SerializeOperation,
): boolean {
  if (!serialize.isReentrant()) return false
  serialize.defer(async () => {
    try {
      await driver.reconcile(await store.list())
    }
    catch (error) {
      reportError(error)
    }
  })
  return true
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
        if (!deferReentrantReconciliation(driver, store, reportError, serialize)) {
          await reconcileAfterMutation(driver, store, async () => {
            if (!await store.delete(created.id)) {
              throw new Error(`Runtime Schedule create rollback failed: ${created.id}`)
            }
          }, reportError)
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
        if (!deferReentrantReconciliation(driver, store, reportError, serialize)) {
          await reconcileAfterMutation(driver, store, async () => {
            if (!previous) {
              throw new Error(`Runtime Schedule delete rollback failed: ${id}`)
            }
            await store.create(previous)
          }, reportError)
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
        if (!deferReentrantReconciliation(driver, store, reportError, serialize)) {
          await reconcileAfterMutation(driver, store, async () => {
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
          }, reportError)
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
  const serialize = createSerializer()
  let driver: RuntimeScheduleWakeDriver | undefined
  let aborted = false

  setScheduleRuntimeRegistry(options.registry)
  setScheduleRunStore(options.scheduleRunStore)

  const initializing = serialize(async () => {
    try {
      driver = await options.createDriver({
        reportError,
        wake: input => executeRuntimeScheduleWake(input, {
          runtimeScheduleStore: options.runtimeScheduleStore,
          scheduleRunStore: options.scheduleRunStore,
        }),
      })
      await driver.reconcile(await options.runtimeScheduleStore.list())
    }
    catch (error) {
      aborted = true
      throw error
    }
  })
  const runtimeScheduleStore = createReconciledStore(options.runtimeScheduleStore, () => {
    if (!driver || aborted) {
      throw new Error("Runtime Schedule wake driver installation did not complete.")
    }
    return driver
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

  if (!driver) {
    throw new Error("Runtime Schedule wake driver installation did not produce a driver.")
  }
  const installedDriver = driver

  let closePromise: Promise<void> | undefined
  return {
    close() {
      return closePromise ??= serialize(async () => {}).then(async () => {
        await installedDriver.close?.()
      })
    },
  }
}
