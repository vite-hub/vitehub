import { emitLogEvent } from "@vite-hub/internal/runtime/request-log"

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

// Errors that a run event has. The console lines for the same failure skip them. One set per runtime.
const loggedKey = Symbol.for("vitehub.schedule.logged-errors")
const runtimeGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const logged = (runtimeGlobal[loggedKey] ||= new WeakSet<object>()) as WeakSet<object>

/**
 * Emits one evlog event for a Schedule run that ran its handler: `{ action: "schedule", schedule }`, at `info` for a
 * success and at `error` with the error for a failure. Without evlog, it does nothing: the run history keeps the run.
 */
export function logScheduleRun(run: Omit<ScheduleRunLogFields, "ms" | "outcome" | "scheduledAt"> & { scheduledAt: Date }, startedAt: number, outcome: ScheduleRunLogFields["outcome"], error?: unknown): void {
  const fields = { ...run, scheduledAt: run.scheduledAt.toISOString(), ms: Math.round(performance.now() - startedAt), outcome } satisfies ScheduleRunLogFields
  const emitted = outcome === "failure"
    ? emitLogEvent({ field: "schedule", fields, level: "error", message: "Schedule run failed", error })
    : emitLogEvent({ field: "schedule", fields, level: "info", message: "Schedule run succeeded" })
  if (emitted && typeof error === "object" && error !== null) logged.add(error)
}

/** Whether a run event already logged this error. */
export function isLoggedScheduleError(error: unknown): boolean {
  return typeof error === "object" && error !== null && logged.has(error)
}
