import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"

import { isScheduleDue } from "./due.ts"
import { executeSchedule, toRunId } from "./execute.ts"
import { getScheduleOccurrenceClaims, getStartedScheduleRuntime, setStartedScheduleRuntime } from "./state.ts"
import { joinKey, keySegments } from "./store.ts"
import { startedScheduleErrors } from "../started-errors.ts"
import { isRecordOrFunction as isRecord } from "@vite-hub/internal/object"

import type { ScheduleKVStorage } from "./kv-storage.ts"
import type { StartedScheduleRuntime } from "./state.ts"
import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunContext, StartedSchedule, StartedScheduleStore } from "../types.ts"

const minuteMs = 60_000

export interface InstallStartedSchedulesOptions {
  /**
   * How far back, in milliseconds, the first tick after a start runs cron minutes that no tick checked. Use it only with
   * a run store that survives restarts, because the run ids dedupe minutes that already ran. Defaults to `0`.
   */
  catchUpMs?: number
  /** Schedule Definitions without `cron`, by name. */
  registry: ScheduleDefinitionRegistry
  store: StartedScheduleStore
}

/** Installs the store and the Definitions that `startSchedule()` and the tick use. The generated Nitro plugin calls it. */
export function installStartedSchedules(options: InstallStartedSchedulesOptions): void {
  setStartedScheduleRuntime({ catchUpMs: options.catchUpMs ?? 0, registry: options.registry, store: options.store })
}

interface StoredStartedSchedule {
  at?: string
  createdAt: string
  cron?: string
  id: string
  payload?: unknown
  name: string
  timeZone?: string
}

function serialize(schedule: StartedSchedule): StoredStartedSchedule {
  return {
    ...(schedule.at ? { at: schedule.at.toISOString() } : {}),
    createdAt: schedule.createdAt.toISOString(),
    ...(schedule.cron === undefined ? {} : { cron: schedule.cron }),
    id: schedule.id,
    ...(schedule.payload === undefined ? {} : { payload: schedule.payload }),
    name: schedule.name,
    ...(schedule.timeZone === undefined ? {} : { timeZone: schedule.timeZone }),
  }
}

function deserialize(stored: StoredStartedSchedule): StartedSchedule {
  return {
    ...(stored.at ? { at: new Date(stored.at) } : {}),
    createdAt: new Date(stored.createdAt),
    ...(stored.cron === undefined ? {} : { cron: stored.cron }),
    id: stored.id,
    ...(stored.payload === undefined ? {} : { payload: stored.payload }),
    name: stored.name,
    ...(stored.timeZone === undefined ? {} : { timeZone: stored.timeZone }),
  }
}

/** Keeps started Schedules in this process only. They are lost on restart. Use it in tests. */
export function createMemoryStartedScheduleStore(): StartedScheduleStore {
  const schedules = new Map<string, StoredStartedSchedule>()
  return {
    async delete(id) {
      return schedules.delete(id)
    },
    async get(id) {
      const stored = schedules.get(id)
      return stored ? deserialize(stored) : undefined
    },
    async list() {
      return [...schedules.values()].map(deserialize)
    },
    async put(schedule) {
      schedules.set(schedule.id, serialize(schedule))
    },
  }
}

export interface KVStartedScheduleStoreOptions {
  kvStore: ScheduleKVStorage
  /** Key prefix. Defaults to `vitehub:schedule`, the prefix of the KV Schedule Run store. */
  prefix?: string
}

/**
 * Keeps started Schedules in KV, one key for each Schedule, so they survive restarts and deploys. A record never changes
 * after `put()`, so `list()` reads each key once per process and then only lists the keys.
 */
export function createKVStartedScheduleStore(options: KVStartedScheduleStoreOptions): StartedScheduleStore {
  const prefix = options.prefix ?? "vitehub:schedule"
  const kv = options.kvStore
  const key = (id: string) => joinKey(prefix, "started-schedules", id)
  const read = new Map<string, StartedSchedule>()
  return {
    async delete(id) {
      read.delete(id)
      if (!await kv.has(key(id))) return false
      await kv.delete(key(id))
      return true
    },
    async get(id) {
      const stored = await kv.get<StoredStartedSchedule>(key(id))
      return stored ? deserialize(stored) : undefined
    },
    async list() {
      const ids = new Set((await kv.keys(`${joinKey(prefix, "started-schedules")}/`)).map(entry => keySegments(entry, 1)[0]!))
      for (const id of read.keys()) if (!ids.has(id)) read.delete(id)
      const schedules: StartedSchedule[] = []
      for (const id of ids) {
        let schedule = read.get(id)
        if (!schedule) {
          const stored = await kv.get<StoredStartedSchedule>(key(id))
          if (!stored) continue
          schedule = deserialize(stored)
          read.set(id, schedule)
        }
        schedules.push(schedule)
      }
      return schedules
    },
    async put(schedule) {
      await kv.set(key(schedule.id), serialize(schedule))
    },
  }
}

function unwrapStartableDefinition(loaded: unknown): ScheduleDefinition | undefined {
  const candidate = isRecord(loaded) && Object.hasOwn(loaded, "default") ? loaded.default : loaded
  return isRecord(candidate) && typeof candidate.handler === "function" && !Object.hasOwn(candidate, "cron")
    // SAFETY: The checks above prove the fields that the tick reads.
    ? candidate as unknown as ScheduleDefinition
    : undefined
}

/** The minutes in `[first, last]` when `schedule` is due, after it was created. A one-time Schedule is due once `at` passed. */
function dueMinutes(schedule: StartedSchedule, first: number, last: number): Date[] {
  if (schedule.at) return schedule.at.getTime() <= last ? [schedule.at] : []
  const due: Date[] = []
  const start = Math.max(first, Math.floor(schedule.createdAt.getTime() / minuteMs) * minuteMs + minuteMs)
  for (let minute = start; minute <= last; minute += minuteMs) {
    const scheduledAt = new Date(minute)
    if (isScheduleDue({ cron: schedule.cron!, id: schedule.id, timeZone: schedule.timeZone }, scheduledAt)) due.push(scheduledAt)
  }
  return due
}

/** Runs one occurrence of a started Schedule. Resolves `false` when another process holds it, so a later tick tries again. */
async function runOccurrence(runtime: StartedScheduleRuntime, schedule: StartedSchedule, scheduledAt: Date, waitUntil: ScheduleRunContext["waitUntil"]): Promise<boolean> {
  const load = Object.hasOwn(runtime.registry, schedule.name) ? runtime.registry[schedule.name] : undefined
  const definition = unwrapStartableDefinition(await load?.())
  if (!definition) {
    // A deploy removed the Definition or gave it a cron. A cron Schedule stays, so it runs again if the Definition returns.
    if (schedule.at) await runtime.store.delete(schedule.id)
    throw startedScheduleErrors.SCHEDULE_NOT_STARTABLE({ name: schedule.name })
  }
  const claims = getScheduleOccurrenceClaims()
  const run = async (markFinal?: () => void) => {
    let final = false
    try {
      await executeSchedule({
        captureHandlerFailure: true,
        ...(claims ? { claimed: true } : {}),
        definition: { handler: context => definition.handler({ ...context, payload: schedule.payload }) },
        onExecution() {
          final = true
          markFinal?.()
        },
        scheduleId: schedule.id,
        scheduledAt,
        source: "started",
        target: schedule.name,
        waitUntil,
      })
    }
    finally {
      // A one-time Schedule runs once, also when the handler fails. The failed run stays in the run history.
      if (schedule.at && final) await runtime.store.delete(schedule.id)
    }
  }
  if (!claims) {
    await run()
    return true
  }
  return await claims.run(toRunId("started", schedule.id, scheduledAt), run) !== "held"
}

/**
 * Runs the started Schedules that are due at the minute of `context.scheduledAt`. It is the handler of the
 * `vitehub/started-schedules` Schedule, which the host wakes each minute. A handler failure is recorded in the run of
 * that started Schedule and logged; it does not fail the tick.
 */
export async function runStartedSchedules(context: ScheduleRunContext): Promise<void> {
  const runtime = getStartedScheduleRuntime()
  if (!runtime) throw startedScheduleErrors.SCHEDULE_STORE_MISSING()
  const minute = Math.floor(context.scheduledAt.getTime() / minuteMs) * minuteMs
  const first = runtime.checkedThrough === undefined
    ? minute - runtime.catchUpMs
    : Math.min(minute, runtime.checkedThrough + minuteMs)
  const schedules = await runtime.store.list()
  const occurrences = schedules.flatMap(schedule => dueMinutes(schedule, first, minute).map(scheduledAt => ({ schedule, scheduledAt })))
  // Occurrences that another process held at an earlier tick. A Schedule that is gone now ran its last time or was cancelled.
  const held = runtime.held ??= new Map()
  const byId = new Map(schedules.map(schedule => [schedule.id, schedule]))
  for (const [runId, entry] of held) {
    const schedule = byId.get(entry.scheduleId)
    if (!schedule) held.delete(runId)
    else if (!occurrences.some(occurrence => occurrence.schedule.id === schedule.id && occurrence.scheduledAt.getTime() === entry.scheduledAt.getTime())) {
      occurrences.push({ schedule, scheduledAt: entry.scheduledAt })
    }
  }
  const results = await Promise.allSettled(occurrences.map(({ schedule, scheduledAt }) => runOccurrence(runtime, schedule, scheduledAt, context.waitUntil)))
  results.forEach((result, index) => {
    const { schedule, scheduledAt } = occurrences[index]!
    const runId = toRunId("started", schedule.id, scheduledAt)
    if (result.status === "fulfilled") {
      if (result.value) held.delete(runId)
      else held.set(runId, { scheduleId: schedule.id, scheduledAt })
      return
    }
    // A first tick can fail before checkedThrough is set. Keep that occurrence for the next tick as well.
    held.set(runId, { scheduleId: schedule.id, scheduledAt })
    console.error(`[vitehub:schedule] Started Schedule "${schedule.id}" of "${schedule.name}" failed.`, normalizeRuntimeDiagnosticError(result.reason, { includeStack: true }))
  })
  if (results.every(result => result.status === "fulfilled")) {
    runtime.checkedThrough = Math.max(runtime.checkedThrough ?? minute, minute)
  }
}
