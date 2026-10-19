import { validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { ViteHubError } from "@vite-hub/runtime"

import { isScheduleDevOperation, scheduleDevHeader, scheduleDevHeaderValue } from "../dev.ts"
import { runSchedule } from "./execute.ts"
import { getScheduleRunStore } from "./state.ts"
import { ScheduleHistoryIncompleteError } from "./store.ts"

import type { ScheduleDevRequestBody } from "../dev.ts"
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
interface ManualScheduleRunSummary {
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

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: { "cache-control": "no-store" }, status })
}

function failure(message: string, status: number, code?: string): Response {
  return json({ error: { ...(code ? { code } : {}), message } }, status)
}

const errorStatus: Readonly<Record<string, number>> = {
  SCHEDULE_DEFINITION_NOT_FOUND: 404,
  SCHEDULE_MANUAL_RUN_DISABLED: 403,
  SCHEDULE_RUN_NOT_FOUND: 404,
}

function scheduleFailure(error: unknown): Response {
  if (error instanceof ScheduleHistoryIncompleteError) {
    return failure(redactInspectionText(error.message), 503, error.code)
  }
  if (!(error instanceof ViteHubError)) {
    return failure("The Schedule operation failed.", 500)
  }
  return failure(redactInspectionText(error.message), errorStatus[error.code] ?? 400, error.code)
}

async function readBody(request: Request): Promise<ScheduleDevRequestBody | undefined> {
  const body: unknown = await request.json().catch(() => undefined)
  if (!body || typeof body !== "object" || Array.isArray(body)) return
  const operation: unknown = Reflect.get(body, "operation")
  const id: unknown = Reflect.get(body, "id")
  const limit: unknown = Reflect.get(body, "limit")
  if (!isScheduleDevOperation(operation)) return
  if (id !== undefined && (typeof id !== "string" || !id)) return
  if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) return
  return {
    ...(id !== undefined ? { id } : {}),
    ...(limit !== undefined ? { limit } : {}),
    operation,
  }
}

interface ScheduleDevRequestOptions {
  authorize?: (request: Request) => Promise<boolean>
  /** Static Schedule registry of the Nitro runtime. `run-static` loads definitions from it. */
  registry?: ScheduleDefinitionRegistry
}

async function runOperation(body: ScheduleDevRequestBody, options: ScheduleDevRequestOptions): Promise<Response> {
  const id = body.id
  if (!id) return failure(`The ${body.operation} operation requires an id.`, 400)
  switch (body.operation) {
    case "runs":
      return json({ runs: await listScheduleRuns(id, { limit: body.limit }) })
    case "attempts": {
      const run = await getScheduleRunStore().getRun(id)
      if (!run) return failure("Schedule Run was not found.", 404, "SCHEDULE_RUN_NOT_FOUND")
      return json({ attempts: await listScheduleRunAttempts(id), run: summarizeScheduleRun(run) })
    }
    case "run-static":
      if (!options.registry) return failure("No Static Schedule registry is installed in this runtime. Restart the Vite Development Server.", 409)
      try {
        return json({ run: summarizeManualScheduleRun(await runSchedule(id, { registry: options.registry })) })
      }
      catch (error) {
        return scheduleFailure(error)
      }
  }
}

/**
 * Handles one Schedule operation from `vitehub schedule`. The Vite Development Server forwards the request into the
 * Nitro runtime, so the operation uses the same stores and registry as the application.
 *
 * The request must carry the Schedule dev header, must not come from another origin, and must use JSON.
 * The owner authorization callback is required. The Node dev entry supplies private project-token verification.
 * `run-static` runs a Static Schedule Definition from `options.registry`. The definition must set `manual: true`.
 */
export async function handleScheduleDevRequest(request: Request, options: ScheduleDevRequestOptions = {}): Promise<Response> {
  const { rejection } = await validateViteHubNitroDevRequest(request, {
    authorize: async request => await options.authorize?.(request) ? undefined : new Response("Forbidden Schedule Dev token.", { status: 403 }),
    header: scheduleDevHeader,
    headerValue: scheduleDevHeaderValue,
    label: "Schedule Dev",
  })
  if (rejection) return rejection
  const body = await readBody(request)
  if (!body) return failure("The Schedule Dev request body is invalid.", 400)
  try {
    return await runOperation(body, options)
  }
  catch (error) {
    return scheduleFailure(error)
  }
}
