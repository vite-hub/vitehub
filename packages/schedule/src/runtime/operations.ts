import { redactInspectionText } from "@vite-hub/internal/inspect"

import { runSchedule } from "./execute.ts"
import { getScheduleRunStore } from "./state.ts"

import type { ScheduleDefinitionRegistry, ScheduleRunAttemptRecord, ScheduleRunAttemptStatus, ScheduleRunError, ScheduleRunRecord, ScheduleRunStatus } from "../types.ts"

/** Error of a run or attempt. The stack is not included. */
export interface ScheduleRunErrorSummary {
  message: string
  name?: string
}

/** Serializable view of one Schedule Run. The response body is not included. */
export interface ScheduleRunSummary {
  attemptCount: number
  completedAt?: string
  error?: ScheduleRunErrorSummary
  id: string
  response?: { status: number, statusText: string }
  scheduleId: string
  scheduledAt: string
  startedAt?: string
  status: ScheduleRunStatus
  target: string
}

/** Serializable view of one Schedule Run attempt. */
export interface ScheduleRunAttemptSummary {
  completedAt?: string
  error?: ScheduleRunErrorSummary
  id: string
  runId: string
  startedAt: string
  status: ScheduleRunAttemptStatus
}

function isoDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

function summarizeError(error: ScheduleRunError | undefined): ScheduleRunErrorSummary | undefined {
  if (!error) return
  const summary: ScheduleRunErrorSummary = { message: redactInspectionText(error.message) }
  if (error.name) summary.name = redactInspectionText(error.name)
  return summary
}

export function summarizeScheduleRun(run: ScheduleRunRecord): ScheduleRunSummary {
  const error = summarizeError(run.error)
  const completedAt = isoDate(run.completedAt)
  const startedAt = isoDate(run.startedAt)
  const summary: ScheduleRunSummary = {
    attemptCount: run.attemptCount,
    id: run.id,
    scheduleId: run.scheduleId,
    scheduledAt: isoDate(run.scheduledAt) ?? "",
    status: run.status,
    target: run.target,
  }
  if (completedAt) summary.completedAt = completedAt
  if (error) summary.error = error
  if (run.response) {
    summary.response = {
      status: run.response.status,
      statusText: redactInspectionText(run.response.statusText),
    }
  }
  if (startedAt) summary.startedAt = startedAt
  return summary
}

/** Serializable view of one manual Static Schedule run, as `vitehub schedule run` prints it. */
export interface ManualScheduleRunSummary {
  completedAt?: string
  error?: ScheduleRunErrorSummary
  id: string
  scheduleId: string
  startedAt?: string
  status: ScheduleRunStatus
}

function summarizeManualScheduleRun(run: ScheduleRunRecord): ManualScheduleRunSummary {
  const error = summarizeError(run.error)
  const completedAt = isoDate(run.completedAt)
  const startedAt = isoDate(run.startedAt)
  return {
    ...(completedAt ? { completedAt } : {}),
    ...(error ? { error } : {}),
    id: run.id,
    scheduleId: run.scheduleId,
    ...(startedAt ? { startedAt } : {}),
    status: run.status,
  }
}

export function summarizeScheduleRunAttempt(attempt: ScheduleRunAttemptRecord): ScheduleRunAttemptSummary {
  const error = summarizeError(attempt.error)
  const completedAt = isoDate(attempt.completedAt)
  return {
    ...(completedAt ? { completedAt } : {}),
    ...(error ? { error } : {}),
    id: attempt.id,
    runId: attempt.runId,
    startedAt: isoDate(attempt.startedAt) ?? "",
    status: attempt.status,
  }
}

function newestFirst(left: ScheduleRunRecord, right: ScheduleRunRecord): number {
  return new Date(right.scheduledAt).getTime() - new Date(left.scheduledAt).getTime()
}

/** Lists the recorded runs of one Schedule Definition, newest first. */
export async function listScheduleRuns(scheduleId: string, options: { limit?: number } = {}): Promise<ScheduleRunSummary[]> {
  const runs = (await getScheduleRunStore().listRuns({ scheduleId, limit: options.limit }))
    .filter(run => run.scheduleId === scheduleId)
    .sort(newestFirst)
  return (options.limit === undefined ? runs : runs.slice(0, options.limit)).map(summarizeScheduleRun)
}

/** Lists the attempts of one Schedule Run, oldest first. */
export async function listScheduleRunAttempts(runId: string): Promise<ScheduleRunAttemptSummary[]> {
  const attempts = await getScheduleRunStore().listAttempts(runId)
  return [...attempts]
    .sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime())
    .map(summarizeScheduleRunAttempt)
}


/** Raised for the failures of a Schedule operation. `status` and `code` reach every surface. */
class ScheduleOperationError extends Error {
  readonly code: string
  readonly fix?: string
  readonly status: number

  constructor(status: number, code: string, message: string, fix?: string) {
    super(message)
    this.code = code
    this.status = status
    if (fix) this.fix = fix
  }
}

const errorStatus: Readonly<Record<string, number>> = {
  SCHEDULE_DEFINITION_NOT_FOUND: 404,
  SCHEDULE_HISTORY_INCOMPLETE: 503,
  SCHEDULE_MANUAL_RUN_DISABLED: 403,
  SCHEDULE_RUN_NOT_FOUND: 404,
}

/** Gives a Schedule error the status and the redacted message that every surface reports. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    if (error instanceof ScheduleOperationError) throw error
    const code: unknown = Reflect.get(Object(error), "code")
    const status = String(code) === code ? errorStatus[code] : undefined
    if (status && error instanceof Error) throw new ScheduleOperationError(status, String(code), redactInspectionText(error.message))
    throw new ScheduleOperationError(500, "OPERATION_FAILED", "Schedule operation failed.")
  }
}

/** Result of `schedule.runs`. */
export interface ScheduleRunsResult {
  runs: ScheduleRunSummary[]
}

/** Result of `schedule.attempts`. */
export interface ScheduleAttemptsResult {
  attempts: ScheduleRunAttemptSummary[]
  run: ScheduleRunSummary
}

/** Result of `schedule.run`. */
export interface ScheduleRunResult {
  run: ManualScheduleRunSummary
}

export async function runScheduleRuns(input: { id: string, limit?: number }): Promise<ScheduleRunsResult> {
  return await attempt(async () => ({ runs: await listScheduleRuns(input.id, { limit: input.limit ?? 100 }) }))
}

export async function runScheduleAttempts(input: { id: string }): Promise<ScheduleAttemptsResult> {
  return await attempt(async () => {
    const run = await getScheduleRunStore().getRun(input.id)
    if (!run) throw new ScheduleOperationError(404, "SCHEDULE_RUN_NOT_FOUND", "Schedule Run was not found.", "List the runs of the Schedule with `vitehub schedule runs <name>` and pass one of their ids.")
    return { attempts: await listScheduleRunAttempts(input.id), run: summarizeScheduleRun(run) }
  })
}

/** The manual Static Schedule Definitions that the Console installed. Only `console.invoke` installs them. */
const consoleSchedulesKey = Symbol.for("vitehub.console.schedules")

/**
 * Runs a Static Schedule Definition that sets `manual: true`. The registry holds only those definitions, and it is empty
 * unless Console invocation is enabled, so anything else is "not available".
 */
export async function runScheduleNow(input: { name: string }, registry: ScheduleDefinitionRegistry = Reflect.get(globalThis, consoleSchedulesKey) ?? {}): Promise<ScheduleRunResult> {
  if (!Object.hasOwn(registry, input.name)) {
    throw new ScheduleOperationError(404, "SCHEDULE_DEFINITION_NOT_FOUND", "Schedule run is not available. Set manual: true on the Schedule Definition and enable Console invocation.", "Set `manual: true` in defineSchedule() and keep `console.invoke` on (it is on in development).")
  }
  return await attempt(async () => ({ run: summarizeManualScheduleRun(await runSchedule(input.name, { registry })) }))
}
