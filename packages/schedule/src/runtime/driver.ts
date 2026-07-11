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

type SerializeOperation = <T>(operation: () => Promise<T>) => Promise<T>

function createSerializer(): SerializeOperation {
  let tail = Promise.resolve()
  return function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation)
    tail = result.then(() => {}, () => {})
    return result
  }
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

function createReconciledStore(
  store: RuntimeScheduleStore,
  driver: RuntimeScheduleWakeDriver,
  reportError: (error: unknown) => void,
): { runtimeScheduleStore: RuntimeScheduleStore, serialize: SerializeOperation } {
  const serialize = createSerializer()
  const runtimeScheduleStore: RuntimeScheduleStore = {
    create(record) {
      return serialize(async () => {
        const created = await store.create(record)
        await reconcileAfterMutation(driver, store, async () => {
          if (!await store.delete(created.id)) {
            throw new Error(`Runtime Schedule create rollback failed: ${created.id}`)
          }
        }, reportError)
        return created
      })
    },
    delete(id) {
      return serialize(async () => {
        const previous = await store.get(id)
        const deleted = await store.delete(id)
        if (!deleted) return false
        await reconcileAfterMutation(driver, store, async () => {
          if (!previous) {
            throw new Error(`Runtime Schedule delete rollback failed: ${id}`)
          }
          await store.create(previous)
        }, reportError)
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
        const previous = await store.get(id)
        const updated = await store.update(id, patch)
        if (!updated) return undefined
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
        return updated
      })
    },
  }

  return { runtimeScheduleStore, serialize }
}

export async function installScheduleRuntime(options: InstallScheduleRuntimeOptions): Promise<ScheduleRuntimeController> {
  const previousRegistry = getScheduleRuntimeRegistry()
  const previousRuntimeScheduleStore = getRuntimeScheduleStore()
  const previousScheduleRunStore = getScheduleRunStore()
  const reportError = createErrorReporter(options.onError)
  let driver: RuntimeScheduleWakeDriver | undefined

  setScheduleRuntimeRegistry(options.registry)
  setRuntimeScheduleStore(options.runtimeScheduleStore)
  setScheduleRunStore(options.scheduleRunStore)

  try {
    driver = await options.createDriver({
      reportError,
      wake: async input => {
        await executeRuntimeScheduleWake(input, {
          runtimeScheduleStore: options.runtimeScheduleStore,
          scheduleRunStore: options.scheduleRunStore,
        })
      },
    })
    await driver.reconcile(await options.runtimeScheduleStore.list())
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

  const installedDriver = driver
  const { runtimeScheduleStore, serialize } = createReconciledStore(options.runtimeScheduleStore, installedDriver, reportError)
  setRuntimeScheduleStore(runtimeScheduleStore)

  let closePromise: Promise<void> | undefined
  return {
    close() {
      return closePromise ??= serialize(async () => {
        await installedDriver.close?.()
      })
    },
  }
}
