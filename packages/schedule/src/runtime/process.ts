import { createProcessWakeDriver } from "../internal/process-wake-runtime.ts"
import { createScheduleError } from "../errors.ts"
import { isScheduleDue } from "./due.ts"
import { executeStaticSchedule } from "./execute.ts"
import { getScheduleRunStore, getScheduleRuntimeRegistry, setScheduleRunStore, setScheduleRuntimeRegistry } from "./state.ts"

import type { ProcessWakeContext } from "../internal/process-wake-runtime.ts"
import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunStore } from "../types.ts"

export interface ProcessScheduleRuntimeOptions {
  /**
   * How far back, in milliseconds, the runtime runs due minutes that it did not check, such as minutes during a
   * restart. It only catches up a Schedule that already has a run. Defaults to one hour. `0` disables it.
   */
  catchUpMs?: number
  /** Maximum number of Schedule runs at the same time. Defaults to `1`. */
  concurrency?: number
  /** Milliseconds between two checks, from 1 to 60000. Defaults to `60000`. */
  intervalMs?: number
  /** Clock for tests. Defaults to the system clock. */
  now?: () => Date
  onError?: (error: unknown) => void
  /** Static Schedule Definitions that this process runs on their cron. */
  registry: ScheduleDefinitionRegistry
  /** Stores Schedule Runs. Catch-up after a restart reads the newest run of each Schedule from it. */
  scheduleRunStore: ScheduleRunStore
}

export interface ScheduleRuntimeController {
  close(): Promise<void>
}

interface StaticScheduleEntry {
  definition: ScheduleDefinition
  name: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

function isStaticScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return isObject(value)
    && Object.hasOwn(value, "cron")
    && Object.hasOwn(value, "handler")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Registry handlers cross module and JavaScript realm boundaries; validate callability without realm-sensitive instanceof.
    && typeof value.handler === "function"
}

function unwrapDefinition(loaded: unknown): ScheduleDefinition | undefined {
  if (isObject(loaded) && Object.hasOwn(loaded, "default") && isStaticScheduleDefinition(loaded.default)) return loaded.default
  return isStaticScheduleDefinition(loaded) ? loaded : undefined
}

async function loadStaticDefinitions(registry: ScheduleDefinitionRegistry): Promise<Map<string, StaticScheduleEntry>> {
  const entries = await Promise.all(Object.entries(registry).map(async ([name, load]) => {
    const definition = unwrapDefinition(await load())
    return definition ? { definition, name } : undefined
  }))
  return new Map(entries.flatMap(entry => entry ? [[entry.name, entry] as const] : []))
}

function createErrorReporter(onError: ProcessScheduleRuntimeOptions["onError"]): (error: unknown) => void {
  return (error) => {
    if (!onError) return
    try {
      void Promise.resolve(onError(error)).catch(() => {})
    }
    catch {}
  }
}

/**
 * Runs Static Schedule Definitions on their UTC cron in this long-running process. It checks every minute, runs each
 * due minute once, and records each run in `scheduleRunStore`. After a restart it runs the minutes that no process
 * checked, within `catchUpMs`, for Schedules that already have a run. Call `close()` during host shutdown.
 */
export async function installProcessScheduleRuntime(options: ProcessScheduleRuntimeOptions): Promise<ScheduleRuntimeController> {
  const previousRegistry = getScheduleRuntimeRegistry()
  const previousScheduleRunStore = getScheduleRunStore()
  const reportError = createErrorReporter(options.onError)
  const pendingWork = new Set<Promise<unknown>>()
  const activeWakes = new Set<Promise<void>>()
  let closing = false
  let definitions = new Map<string, StaticScheduleEntry>()

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

  const context: ProcessWakeContext = {
    async latestScheduledAt(scheduleId) {
      const [run] = await options.scheduleRunStore.listRuns({ limit: 1, scheduleId })
      return run?.scheduledAt
    },
    reportError,
    wake(input) {
      if (closing) return Promise.resolve()
      const wake = (async () => {
        const entry = definitions.get(input.scheduleId)
        if (!entry || !isScheduleDue({ cron: entry.definition.cron, id: entry.name }, input.scheduledAt)) {
          throw createScheduleError("SCHEDULE_NOT_DUE")
        }
        await executeStaticSchedule({
          cron: entry.definition.cron,
          definition: entry.definition,
          name: entry.name,
          scheduledAt: input.scheduledAt,
          waitUntil,
        })
      })()
      activeWakes.add(wake)
      void wake.finally(() => activeWakes.delete(wake)).catch(() => {})
      return wake
    },
  }
  const driver = createProcessWakeDriver(options, context)

  setScheduleRuntimeRegistry(options.registry)
  setScheduleRunStore(options.scheduleRunStore)
  try {
    definitions = await loadStaticDefinitions(options.registry)
    await driver.reconcile([...definitions.values()].map(entry => ({ cron: entry.definition.cron, id: entry.name })))
  }
  catch (error) {
    try {
      await driver.close()
    }
    catch (closeError) {
      reportError(closeError)
    }
    setScheduleRuntimeRegistry(previousRegistry)
    setScheduleRunStore(previousScheduleRunStore)
    throw error
  }

  let closePromise: Promise<void> | undefined
  return {
    close() {
      if (closePromise) return closePromise
      closing = true
      return closePromise = (async () => {
        while (activeWakes.size > 0) {
          await Promise.allSettled(activeWakes)
        }
        while (pendingWork.size > 0) {
          await Promise.allSettled(pendingWork)
        }
        await driver.close()
      })()
    },
  }
}
