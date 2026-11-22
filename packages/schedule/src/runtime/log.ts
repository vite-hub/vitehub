import { emitLogEvent } from "@vite-hub/internal/runtime/request-log"

import type { WaitUntil } from "@vite-hub/internal/runtime/request-log"

/** The `schedule` field of the evlog event of one Schedule run. */
export interface ScheduleRunLogFields {
  /** The Schedule Definition. */
  name: string
  /** The id of a started Schedule, when it is not the Definition name. */
  id?: string
  runId?: string
  source: "direct" | "manual" | "started" | "static"
  scheduledAt: string
  attempt?: number
  ms: number
  outcome: "success" | "failure"
}

const loggedKey = Symbol.for("vitehub.schedule.logged-errors")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const logged = (runtimeGlobal[loggedKey] ||= new WeakSet<object>()) as WeakSet<object>

/**
 * Emits one evlog event for a Schedule run that ran its handler: `{ action: "schedule", schedule }`, at `info` for a
 * success and at `error` with the handler's error for a failure. The handler is the app's own code, so its error goes
 * on the event as a route's error does. Returns whether evlog has the event. Without evlog, it does nothing: the run
 * history keeps the run.
 */
export function logScheduleRun(run: Omit<ScheduleRunLogFields, "ms" | "outcome" | "scheduledAt"> & { scheduledAt: Date }, startedAt: number, outcome: ScheduleRunLogFields["outcome"], options: { error?: unknown, waitUntil?: WaitUntil } = {}): boolean {
  const fields = { ...run, scheduledAt: run.scheduledAt.toISOString(), ms: Math.round(performance.now() - startedAt), outcome } satisfies ScheduleRunLogFields
  const waitUntil = options.waitUntil ? { waitUntil: options.waitUntil } : {}
  return outcome === "failure"
    ? emitLogEvent({ field: "schedule", fields, level: "error", message: "Schedule run failed", error: options.error, withError: true, ...waitUntil })
    : emitLogEvent({ field: "schedule", fields, level: "info", message: "Schedule run succeeded", ...waitUntil })
}

/** Notes that a log event has this error. An error that is not an object cannot be noted: wrap it first. */
export function rememberLoggedScheduleError(error: object): void {
  logged.add(error)
}

/** Whether a log event already has this error. */
export function isLoggedScheduleError(error: unknown): boolean {
  return typeof error === "object" && error !== null && logged.has(error)
}
