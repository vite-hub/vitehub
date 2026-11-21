export { onShutdown } from "@vite-hub/runtime/internal/shutdown"

import { hostname } from "node:os"

import { isRecordOrFunction as isObject } from "@vite-hub/internal/object"

import { createMemoryLeaseStore } from "@vite-hub/runtime"

import { createProcessWakeDriver, DEFAULT_CATCH_UP_MS } from "../internal/process-wake-runtime.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"
import { createScheduleError } from "../errors.ts"
import { createOccurrenceClaims } from "./claims.ts"
import { scheduleIdempotencyKey } from "./date.ts"
import { isScheduleDue } from "./due.ts"
import { executeStaticSchedule, toRunId } from "./execute.ts"
import { markLoggedScheduleError } from "./static.ts"
import { runStartedSchedules } from "./started.ts"
import { getScheduleOccurrenceClaims, getScheduleRunStore, getScheduleRuntimeRegistry, registerProcessScheduleDefinitions, setScheduleOccurrenceClaims, setScheduleRunStore, setScheduleRuntimeRegistry } from "./state.ts"

import type { LeaseStore } from "@vite-hub/runtime"
import type { ProcessScheduleWake, ProcessWakeContext } from "../internal/process-wake-runtime.ts"
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
  /**
   * Milliseconds that a process holds an occurrence after it stops renewing it, for example after a crash. Then another
   * process runs the occurrence, if no process finished it. The holder renews it every third of this time. Defaults to
   * `60000`.
   */
  leaseTtlMs?: number
  /**
   * Where processes claim each occurrence, so one process runs it. Give every process the same shared store, such as
   * `createSqlLeaseStore()` from `@vite-hub/runtime` on the app Database. Defaults to `createMemoryLeaseStore()`, which
   * works for one process only.
   */
  leases?: LeaseStore
  /** Clock for tests. Defaults to the system clock. */
  now?: () => Date
  onError?: (error: unknown) => void
  /** Namespace for occurrence leases. Use the same prefix as the app's Schedule stores. Defaults to `vitehub:schedule`. */
  prefix?: string
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

type CronScheduleDefinition = ScheduleDefinition & { cron: string }

interface StaticScheduleEntry extends ProcessScheduleTiming {
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

function lazyDefinition(name: string, load: ScheduleDefinitionRegistry[string]): () => Promise<CronScheduleDefinition> {
  let loading: Promise<CronScheduleDefinition> | undefined
  return () => loading ??= load().then((loaded) => {
    const definition = unwrapDefinition(loaded)
    if (!definition) throw scheduleErrorDiagnostics.SCHEDULE_DEFINITION_EXPORT_INVALID({ name })
    return definition
  }).catch((error: unknown) => {
    loading = undefined
    throw error
  })
}

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

const DEFAULT_LEASE_TTL_MS = 60_000
const minuteMs = 60_000

function resolveLeaseTtlMs(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0024({ message: "Process Schedule Runtime leaseTtlMs must be a positive number." })
  }
  return value
}

/**
 * Runs Static Schedule Definitions on their cron, in their `timeZone` (UTC by default), in this long-running process. It checks every minute, runs each
 * due minute once, and records each run in `scheduleRunStore`. After a restart it runs the minutes that no process
 * checked, within `catchUpMs`, for Schedules with a prior cron-triggered run or indeterminate legacy history.
 * Processes that share `leases` run each occurrence once between them. Call `close()` during host shutdown.
 */
export async function installProcessScheduleRuntime(options: ProcessScheduleRuntimeOptions): Promise<ScheduleRuntimeController> {
  const previousRegistry = getScheduleRuntimeRegistry()
  const previousScheduleRunStore = getScheduleRunStore()
  const previousClaims = getScheduleOccurrenceClaims()
  const reportError = createErrorReporter(options.onError)
  const leaseTtlMs = resolveLeaseTtlMs(options.leaseTtlMs)
  const claims = createOccurrenceClaims({
    doneTtlMs: (options.catchUpMs ?? DEFAULT_CATCH_UP_MS) + leaseTtlMs + 2 * minuteMs,
    leases: options.leases ?? createMemoryLeaseStore(),
    owner: `${hostname()}:${process.pid}`,
    prefix: options.prefix,
    reportError,
    ttlMs: leaseTtlMs,
  })
  const held = new Map<string, ProcessScheduleWake>()
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
      const [run] = await options.scheduleRunStore.listRuns({ scheduleId, idPrefix: "srun_static_", limit: 1 })
      if (!run || run.id.startsWith("srun_static_")) return run?.scheduledAt
      const limit = 100
      const recent = await options.scheduleRunStore.listRuns({ scheduleId, limit })
      const latest = recent.find(record => record.id.startsWith("srun_static_"))
      if (latest) return latest.scheduledAt
      return recent.length < limit ? undefined : "unknown"
    },
    reportError,
    retries() {
      const currentMinute = Math.floor((options.now?.() ?? new Date()).getTime() / minuteMs) * minuteMs
      const since = currentMinute - (options.catchUpMs ?? DEFAULT_CATCH_UP_MS)
      for (const [runId, input] of held) {
        if (input.scheduledAt.getTime() < since) held.delete(runId)
      }
      return [...held.values()]
    },
    wake(input) {
      if (closing) return Promise.resolve()
      const wake = (async () => {
        const entry = definitions.get(input.scheduleId)
        if (!entry || !isScheduleDue(scheduleCronRecord(entry), input.scheduledAt)) {
          throw createScheduleError("SCHEDULE_NOT_DUE")
        }
        const definition = await entry.definition()
        if (definition.handler === runStartedSchedules) {
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
        const runId = toRunId("static", entry.name, input.scheduledAt)
        let logged = false
        try {
          const result = await claims.run(runId, onExecution => executeStaticSchedule({
            claimed: true,
            cron: entry.cron,
            definition,
            name: entry.name,
            onExecution,
            onRunLogged: () => { logged = true },
            scheduledAt: input.scheduledAt,
            waitUntil,
          }))
          if (result === "held") held.set(runId, { scheduleId: input.scheduleId, scheduledAt: input.scheduledAt })
          else held.delete(runId)
        }
        catch (error) {
          held.set(runId, { scheduleId: input.scheduleId, scheduledAt: input.scheduledAt })
          throw logged ? markLoggedScheduleError(error) : error
        }
      })()
      activeWakes.add(wake)
      void wake.finally(() => activeWakes.delete(wake)).catch(() => {})
      return wake
    },
  }
  const driver = createProcessWakeDriver(options, context)

  async function recoverUnfinishedOccurrences(): Promise<void> {
    const catchUpMs = options.catchUpMs ?? DEFAULT_CATCH_UP_MS
    if (catchUpMs <= 0) return
    const currentMinute = Math.floor((options.now?.() ?? new Date()).getTime() / minuteMs) * minuteMs
    const since = currentMinute - catchUpMs
    for (const entry of definitions.values()) {
      try {
        let due = 0
        for (let minute = Math.ceil(since / minuteMs) * minuteMs; minute <= currentMinute; minute += minuteMs) {
          if (isScheduleDue(scheduleCronRecord(entry), new Date(minute))) due++
        }
        if (due === 0) continue
        const runs = await options.scheduleRunStore.listRuns({ idPrefix: "srun_static_", limit: due, scheduleId: entry.name })
        for (const run of runs) {
          if (run.scheduledAt.getTime() < since || !run.id.startsWith("srun_static_")) continue
          if (run.status !== "pending" && run.status !== "running") continue
          held.set(run.id, { scheduleId: entry.name, scheduledAt: run.scheduledAt })
        }
      }
      catch (error) {
        reportError(error)
      }
    }
  }

  setScheduleRuntimeRegistry(options.registry)
  setScheduleRunStore(options.scheduleRunStore)
  setScheduleOccurrenceClaims(claims)
  try {
    definitions = await loadStaticDefinitions(options.registry, options.timings)
    await recoverUnfinishedOccurrences()
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
    setScheduleOccurrenceClaims(previousClaims)
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
        if (getScheduleOccurrenceClaims() === claims) setScheduleOccurrenceClaims(undefined)
      })()
    },
  }
}
