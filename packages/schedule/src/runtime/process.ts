export { onShutdown } from "@vite-hub/runtime/shutdown"

import { createProcessWakeDriver } from "../internal/process-wake-runtime.ts"
import { createScheduleError } from "../errors.ts"
import { scheduleIdempotencyKey } from "./date.ts"
import { isScheduleDue } from "./due.ts"
import { executeStaticSchedule } from "./execute.ts"
import { runStartedSchedules } from "./started.ts"
import { getScheduleRunStore, getScheduleRuntimeRegistry, registerProcessScheduleDefinitions, setScheduleRunStore, setScheduleRuntimeRegistry } from "./state.ts"
import { isRecordOrFunction as isObject } from "@vite-hub/internal/object"

import type { ProcessWakeContext } from "../internal/process-wake-runtime.ts"
import type { ScheduleCronRecord } from "./due.ts"
import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunStore } from "../types.ts"

export interface ProcessScheduleRuntimeOptions {
  /**
   * How far back, in milliseconds, the runtime runs due minutes that it did not check, such as minutes during a
   * restart. It catches up Schedules with a prior cron-triggered run, or indeterminate legacy history.
   * Defaults to one hour. `0` disables it.
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
  /**
   * The cron and time zone that the build read from the source of each Schedule in `registry`. The runtime loads the
   * module of a Schedule listed here when it is due, not at startup. It loads the other Schedules at startup.
   */
  timings?: Readonly<Record<string, ProcessScheduleTiming>>
  /** Stores Schedule Runs. Catch-up after a restart reads the newest cron-triggered run of each Schedule from it. */
  scheduleRunStore: ScheduleRunStore
}

export interface ScheduleRuntimeController {
  close(): Promise<void>
}

/** The cron of a Schedule and its time zone, UTC when not set. */
export interface ProcessScheduleTiming {
  cron: string
  timeZone?: string
}

/** A Definition with its own cron. Definitions without `cron` run only through started Schedules. */
type CronScheduleDefinition = ScheduleDefinition & { cron: string }

interface StaticScheduleEntry extends ProcessScheduleTiming {
  /** The Definition, loaded at startup or on the first wake. */
  definition: () => Promise<CronScheduleDefinition>
  name: string
}

function isStaticScheduleDefinition(value: unknown): value is CronScheduleDefinition {
  return isObject(value)
    && Object.hasOwn(value, "cron")
    && Object.hasOwn(value, "handler")
    && typeof value.handler === "function"
}

function unwrapDefinition(loaded: unknown): CronScheduleDefinition | undefined {
  if (isObject(loaded) && Object.hasOwn(loaded, "default") && isStaticScheduleDefinition(loaded.default)) return loaded.default
  return isStaticScheduleDefinition(loaded) ? loaded : undefined
}

function isTiming(value: unknown): value is ProcessScheduleTiming {
  return isObject(value) && String(value.cron) === value.cron && (value.timeZone === undefined || String(value.timeZone) === value.timeZone)
}

/** Loads a Definition once, and again only after the load fails. */
function lazyDefinition(name: string, load: ScheduleDefinitionRegistry[string]): () => Promise<CronScheduleDefinition> {
  let loading: Promise<CronScheduleDefinition> | undefined
  return () => loading ??= load().then((loaded) => {
    const definition = unwrapDefinition(loaded)
    if (!definition) throw new TypeError(`Schedule "${name}" has no default export of defineSchedule() with a cron and a handler.`)
    return definition
  }).catch((error: unknown) => {
    loading = undefined
    throw error
  })
}

/**
 * Loads the Definitions without a build timing now and keeps the others lazy. A Definition without a cron and a handler
 * is skipped.
 */
async function loadStaticDefinitions(registry: ScheduleDefinitionRegistry, timings: ProcessScheduleRuntimeOptions["timings"] = {}): Promise<Map<string, StaticScheduleEntry>> {
  const entries = await Promise.all(Object.entries(registry).map(async ([name, load]): Promise<StaticScheduleEntry | undefined> => {
    const timing = Object.hasOwn(timings, name) ? timings[name] : undefined
    if (isTiming(timing)) {
      return { cron: timing.cron, definition: lazyDefinition(name, load), name, ...(timing.timeZone ? { timeZone: timing.timeZone } : {}) }
    }
    const definition = unwrapDefinition(await load())
    if (!definition) return undefined
    return { cron: definition.cron, definition: async () => definition, name, ...(definition.timeZone ? { timeZone: definition.timeZone } : {}) }
  }))
  return new Map(entries.flatMap(entry => entry ? [[entry.name, entry] as const] : []))
}

function scheduleCronRecord(entry: StaticScheduleEntry): ScheduleCronRecord {
  return {
    cron: entry.cron,
    id: entry.name,
    ...(entry.timeZone ? { timeZone: entry.timeZone } : {}),
  }
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
 * Runs Static Schedule Definitions on their cron, in their `timeZone` (UTC by default), in this long-running process. It checks every minute, runs each
 * due minute once, and records each run in `scheduleRunStore`. After a restart it runs the minutes that no process
 * checked, within `catchUpMs`, for Schedules with a prior cron-triggered run or indeterminate legacy history.
 * Call `close()` during host shutdown.
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
      // Manual runs can use simulated times and must not move the cron catch-up cursor.
      const [run] = await options.scheduleRunStore.listRuns({ scheduleId, idPrefix: "srun_static_", limit: 1 })
      if (!run || run.id.startsWith("srun_static_")) return run?.scheduledAt
      // Older custom stores may ignore idPrefix. Look for a cron run without loading their full history.
      const limit = 100
      const recent = await options.scheduleRunStore.listRuns({ scheduleId, limit })
      const latest = recent.find(record => record.id.startsWith("srun_static_"))
      if (latest) return latest.scheduledAt
      // A full page cannot prove there is no earlier cron run. Check the configured window instead;
      // deterministic static IDs deduplicate existing occurrences, including ones outside this page.
      return recent.length < limit ? undefined : "unknown"
    },
    reportError,
    wake(input) {
      if (closing) return Promise.resolve()
      const wake = (async () => {
        const entry = definitions.get(input.scheduleId)
        if (!entry || !isScheduleDue(scheduleCronRecord(entry), input.scheduledAt)) {
          throw createScheduleError("SCHEDULE_NOT_DUE")
        }
        const definition = await entry.definition()
        if (definition.handler === runStartedSchedules) {
          // The tick of started Schedules records no run: it would add one each minute. Each started Schedule records its own.
          await runStartedSchedules({
            id: `tick_${input.scheduledAt.toISOString()}`,
            idempotencyKey: scheduleIdempotencyKey(entry.name, input.scheduledAt),
            scheduledAt: input.scheduledAt,
            scheduleId: entry.name,
            target: entry.name,
            waitUntil,
          })
          return
        }
        await executeStaticSchedule({
          cron: entry.cron,
          definition,
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
    definitions = await loadStaticDefinitions(options.registry, options.timings)
    await driver.reconcile([...definitions.values()].map(scheduleCronRecord))
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

  const processDefinitions = new Map([...definitions].map(([name, entry]) => [name, { cron: entry.cron, ...(entry.timeZone ? { timeZone: entry.timeZone } : {}) }]))
  const unregisterDefinitions = registerProcessScheduleDefinitions(processDefinitions)

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
        unregisterDefinitions()
      })()
    },
  }
}
