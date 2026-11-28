import { redactInspectionText } from "@vite-hub/internal/inspect"

import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"
import { createScheduleError } from "../errors.ts"
import { loadScheduleRegistry } from "../run.ts"
import { loadStaticScheduleDefinition, runScheduleFrom } from "./execute.ts"
import { startedSchedulesTickName } from "./started-name.ts"
import { getHostScheduleInventory, getProcessScheduleDefinitions, getScheduleRunStore, getStartedScheduleRuntime } from "./state.ts"
import { cancelSchedule, listSchedules, startSchedule } from "../started.ts"

import type { ResultError } from "@vite-hub/runtime"
import type { ScheduleDefinitionRegistry, ScheduleRunAttemptRecord, ScheduleRunAttemptStatus, ScheduleRunError, ScheduleRunRecord, ScheduleRunStatus, StartedSchedule, StartScheduleOptions } from "../types.ts"

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
  /** The fire time that the handler received. */
  scheduledAt: string
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
    scheduledAt: isoDate(run.scheduledAt) ?? "",
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


function withStatus<TError extends Error>(error: TError, status: number, fix?: string): TError {
  return Object.defineProperties(error, {
    ...(fix && !Reflect.get(error, "fix") ? { fix: { configurable: true, enumerable: false, value: fix, writable: true } } : {}),
    status: { configurable: true, enumerable: false, value: status, writable: true },
    statusMessage: { configurable: true, enumerable: false, value: redactInspectionText(error.message), writable: true },
  })
}

const errorFix: Readonly<Record<string, string>> = {
  SCHEDULE_INVALID_SCHEDULED_AT: "Pass `at` as an ISO 8601 date-time with a time zone, such as 2026-01-31T23:59:00Z or 2026-01-31T23:59:00+01:00.",
  SCHEDULE_MANUAL_RUN_DISABLED: "Set `manual: true` in defineSchedule() to let `vitehub schedule run`, the Console, and `runSchedule()` start the Schedule.",
}

const errorStatus: Readonly<Record<string, number>> = {
  SCHEDULE_DEFINITION_NOT_FOUND: 404,
  SCHEDULE_INVALID_SCHEDULED_AT: 400,
  SCHEDULE_MANUAL_RUN_DISABLED: 403,
  SCHEDULE_OPERATION_FAILED: 500,
  SCHEDULE_RUN_NOT_FOUND: 404,
}

async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  }
  catch (error) {
    const code: unknown = Reflect.get(Object(error), "code")
    const status = String(code) === code ? errorStatus[code] : undefined
    if (status && error instanceof Error) throw withStatus(error, status, errorFix[String(code)])
    throw withStatus(scheduleErrorDiagnostics.SCHEDULE_OPERATION_FAILED({ cause: error }), 500)
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
    if (!run) throw scheduleErrorDiagnostics.SCHEDULE_RUN_NOT_FOUND()
    return { attempts: await listScheduleRunAttempts(input.id), run: summarizeScheduleRun(run) }
  })
}

const consoleSchedulesKey = Symbol.for("vitehub.console.schedules")

/**
 * Runs a Static Schedule as if its cron fired at `at` (default: now) when its Definition is in the Console registry.
 * A known Definition without `manual: true` fails with `SCHEDULE_MANUAL_RUN_DISABLED`. Other unavailable names fail with `SCHEDULE_DEFINITION_NOT_FOUND`.
 */
export async function runScheduleNow(input: { at?: string, name: string }, registry: ScheduleDefinitionRegistry = Reflect.get(globalThis, consoleSchedulesKey) ?? {}): Promise<ScheduleRunResult> {
  return await attempt(async () => {
    if (!Object.hasOwn(registry, input.name)) {
      const definitions = await loadScheduleRegistry().catch((cause: unknown) => {
        throw scheduleErrorDiagnostics.SCHEDULE_DEFINITION_NOT_FOUND({ cause })
      })
      const definition = await loadStaticScheduleDefinition(input.name, definitions)
      if (definition && definition.options?.manual !== true) throw createScheduleError("SCHEDULE_MANUAL_RUN_DISABLED")
      throw scheduleErrorDiagnostics.SCHEDULE_DEFINITION_NOT_FOUND()
    }
    return { run: summarizeManualScheduleRun(await runScheduleFrom(registry, input.name, { scheduledAt: input.at })) }
  })
}

/** Serializable view of one started Schedule, as `vitehub schedule list` prints it. */
export interface StartedScheduleSummary {
  at?: string
  createdAt: string
  cron?: string
  id: string
  name: string
  payload?: unknown
  timeZone?: string
}

function summarizeStartedSchedule(schedule: StartedSchedule): StartedScheduleSummary {
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

const startedErrorStatus: Readonly<Record<string, number>> = {
  SCHEDULE_INVALID_OPTIONS: 400,
  SCHEDULE_NOT_FOUND: 404,
  SCHEDULE_NOT_STARTABLE: 404,
  SCHEDULE_STORE_FAILED: 503,
  SCHEDULE_STORE_MISSING: 503,
}

function operationError(error: ResultError): ResultError {
  return withStatus(error, startedErrorStatus[error.code] ?? 500)
}

/** Serializable view of one Static Schedule Definition, which runs on its own `cron`. */
export interface ScheduleDefinitionSummary {
  cron: string
  name: string
  timeZone?: string
}

/** Result of `schedule.list`. */
export interface ScheduleListResult {
  /** The Static Schedule Definitions of this server, by name. */
  definitions: ScheduleDefinitionSummary[]
  /** The Schedules that code started with `startSchedule()`, oldest first. Empty when no Definition can be started. */
  schedules: StartedScheduleSummary[]
}

/** Result of `schedule.start` and `schedule.cancel`. */
export interface StartedScheduleResult {
  schedule: StartedScheduleSummary
}

async function listStaticSchedules(filter?: string): Promise<ScheduleDefinitionSummary[]> {
  const inventory = getHostScheduleInventory()
  const registry = inventory?.registry ?? {}
  const timings = new Map([...Object.entries(inventory?.timings ?? {}), ...(getProcessScheduleDefinitions() ?? [])])
  const names = [...new Set([...timings.keys(), ...Object.keys(registry)])]
    .filter(name => name !== startedSchedulesTickName && (filter === undefined || name === filter))
    .sort((left, right) => left.localeCompare(right))
  const definitions = await Promise.all(names.map(async name => [name, timings.get(name) ?? await loadStaticScheduleDefinition(name, registry)] as const))
  return definitions.flatMap(([name, definition]) => definition?.cron === undefined
    ? []
    : [{ cron: definition.cron, name, ...(definition.timeZone === undefined ? {} : { timeZone: definition.timeZone }) }])
}

/**
 * Lists the Static Schedule Definitions and the Schedules that code started. An app with only cron Schedules has no store
 * for started Schedules, so it lists only its Definitions.
 */
export async function runScheduleList(input: { name?: string }): Promise<ScheduleListResult> {
  const definitions = await listStaticSchedules(input.name)
  if (!getStartedScheduleRuntime()) return { definitions, schedules: [] }
  const [error, schedules] = await listSchedules(input.name === undefined ? {} : { name: input.name })
  if (error) throw operationError(error)
  return { definitions, schedules: schedules.map(summarizeStartedSchedule) }
}

export async function runScheduleStart(input: { at?: string, cron?: string, name: string, payload?: unknown, timeZone?: string }): Promise<StartedScheduleResult> {
  const { name, ...options } = input
  // SAFETY: startSchedule() validates the options, including at/cron exclusivity, and returns an error for bad input.
  const [error, schedule] = await startSchedule(name, options as StartScheduleOptions)
  if (error) throw operationError(error)
  return { schedule: summarizeStartedSchedule(schedule) }
}

export async function runScheduleCancel(input: { id: string }): Promise<StartedScheduleResult> {
  const [error, schedule] = await cancelSchedule(input.id)
  if (error) throw operationError(error)
  return { schedule: summarizeStartedSchedule(schedule) }
}
