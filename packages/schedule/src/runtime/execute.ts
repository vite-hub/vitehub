import { randomId } from "@vite-hub/internal/runtime/random"
import { isRecordOrFunction as isObjectRecord } from "@vite-hub/internal/object"
import { serializeResponse, toResponse } from "@vite-hub/runtime"
import { emitRunFailed, toRunFailedError } from "@vite-hub/runtime/internal/run-failed"
import { runInRunScopes } from "@vite-hub/runtime/internal/run-scope"

import { createScheduleError } from "../errors.ts"
import { parseScheduledAt, scheduleIdempotencyKey, validateScheduledAt } from "./date.ts"
import { getScheduleRunStore } from "./state.ts"
import { runWithScheduleWaitUntil } from "./wait-until.ts"

import type { ScheduleDefinition, ScheduleDefinitionRegistry, ScheduleRunAttemptRecord, ScheduleRunContext, ScheduleRunError, ScheduleRunRecord, ScheduleRunStore } from "../types.ts"

interface ExecuteScheduleOptions {
  captureHandlerFailure?: boolean
  claimed?: boolean
  definition: ScheduleDefinition
  onExecution?: () => void
  runStore?: ScheduleRunStore
  runIdSuffix?: string
  scheduleId: string
  source?: "direct" | "manual" | "started" | "static"
  scheduledAt?: Date
  target: string
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

interface ExecuteStaticScheduleOptions {
  claimed?: boolean
  cron: string
  definition: ScheduleDefinition
  name: string
  onExecution?: () => void
  scheduledAt?: Date
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

export interface RunScheduleOptions {
  /**
   * The time the handler receives as `scheduledAt`, as if the cron fired then. A string is an ISO 8601 date-time with a
   * time zone, such as `"2026-01-31T23:59:00Z"`. Defaults to now. The run records this time.
   */
  scheduledAt?: Date | string
}

function normalizeRunSource(source: ExecuteScheduleOptions["source"]): NonNullable<ExecuteScheduleOptions["source"]> {
  return source ?? "direct"
}

/** Returns the Schedule Run id for one scheduled occurrence, with an optional unique suffix. */
export function toRunId(source: ExecuteScheduleOptions["source"], scheduleId: string, scheduledAt: Date, runIdSuffix?: string): string {
  return `srun_${normalizeRunSource(source)}_${encodeURIComponent(scheduleId)}_${scheduledAt.toISOString()}${runIdSuffix ? `_${runIdSuffix}` : ""}`
}

export { isScheduleDate, validateScheduledAt } from "./date.ts"

function toRunError(error: unknown): ScheduleRunError {
  try {
    if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name,
        stack: error.stack,
      }
    }
    return { message: String(error) }
  }
  catch {
    return { message: "[unprintable thrown value]" }
  }
}

function requireUpdatedRun(run: ScheduleRunRecord | undefined): ScheduleRunRecord {
  if (!run) {
    throw createScheduleError("SCHEDULE_RUN_NOT_FOUND")
  }
  return run
}

async function createOrGetRun(options: Omit<ExecuteScheduleOptions, "definition"> & { scheduledAt: Date }): Promise<{ created: boolean, run: ScheduleRunRecord }> {
  const store = options.runStore ?? getScheduleRunStore()
  const id = toRunId(options.source, options.scheduleId, options.scheduledAt, options.runIdSuffix)
  const existing = await store.getRun(id)
  if (existing) {
    return { created: false, run: existing }
  }

  const now = new Date()
  const runInput = {
    attemptCount: 0,
    createdAt: now,
    id,
    scheduleId: options.scheduleId,
    scheduledAt: options.scheduledAt,
    status: "pending" as const,
    target: options.target,
    updatedAt: now,
  }

  try {
    return {
      created: true,
      run: await store.createRun(runInput),
    }
  }
  catch (error) {
    const run = await store.getRun(id)
    if (run) {
      return { created: false, run }
    }
    throw error
  }
}

async function startAttempt(run: ScheduleRunRecord, store: ScheduleRunStore = getScheduleRunStore()): Promise<ScheduleRunAttemptRecord> {
  const now = new Date()
  const attempt = await store.createAttempt({
    createdAt: now,
    id: randomId("satt"),
    runId: run.id,
    startedAt: now,
    status: "running",
    updatedAt: now,
  })
  await store.updateRun(run.id, {
    attemptCount: run.attemptCount + 1,
    startedAt: run.startedAt ?? now,
    status: "running",
    updatedAt: now,
  })
  return attempt
}

function toHandlerContext(
  run: ScheduleRunRecord,
  attempt: ScheduleRunAttemptRecord,
  waitUntil: (promise: PromiseLike<unknown>) => void,
): ScheduleRunContext {
  return {
    attemptId: attempt.id,
    id: run.id,
    idempotencyKey: scheduleIdempotencyKey(run.scheduleId, run.scheduledAt),
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduledAt: run.scheduledAt,
    target: run.target,
    waitUntil,
  }
}

async function completeRun(run: ScheduleRunRecord, attempt: ScheduleRunAttemptRecord, response: ScheduleRunRecord["response"], store: ScheduleRunStore = getScheduleRunStore()): Promise<ScheduleRunRecord> {
  const now = new Date()
  await store.updateAttempt(attempt.id, {
    completedAt: now,
    status: "succeeded",
    updatedAt: now,
  })
  return requireUpdatedRun(await store.updateRun(run.id, {
    completedAt: now,
    response,
    status: "succeeded",
    updatedAt: now,
  }))
}

async function failRun(run: ScheduleRunRecord, attempt: ScheduleRunAttemptRecord, error: unknown, store: ScheduleRunStore = getScheduleRunStore()): Promise<ScheduleRunRecord> {
  const now = new Date()
  const serializedError = toRunError(error)
  await store.updateAttempt(attempt.id, {
    completedAt: now,
    error: serializedError,
    status: "failed",
    updatedAt: now,
  })
  return requireUpdatedRun(await store.updateRun(run.id, {
    completedAt: now,
    error: serializedError,
    status: "failed",
    updatedAt: now,
  }))
}

const stoppedAttemptError: ScheduleRunError = {
  message: "The process that ran this attempt stopped before the attempt finished.",
  name: "ScheduleAttemptStopped",
}

async function failStoppedAttempts(run: ScheduleRunRecord, store: ScheduleRunStore): Promise<void> {
  const now = new Date()
  for (const attempt of await store.listAttempts(run.id)) {
    if (attempt.status !== "running") continue
    await store.updateAttempt(attempt.id, { completedAt: now, error: stoppedAttemptError, status: "failed", updatedAt: now })
  }
}

export async function createScheduleRun(options: Omit<ExecuteScheduleOptions, "definition" | "waitUntil">): Promise<ScheduleRunRecord> {
  const scheduledAt = validateScheduledAt(options.scheduledAt ?? new Date())
  return (await createOrGetRun({ ...options, scheduledAt })).run
}

export async function executeSchedule(options: ExecuteScheduleOptions): Promise<ScheduleRunRecord> {
  const scheduledAt = validateScheduledAt(options.scheduledAt ?? new Date())
  const { created, run } = await createOrGetRun({ ...options, scheduledAt })

  const runStore = options.runStore ?? getScheduleRunStore()
  if (!created) {
    if (!options.claimed || run.status === "succeeded" || run.status === "failed") {
      options.onExecution?.()
      return run
    }
    await failStoppedAttempts(run, runStore)
  }

  const attempt = await startAttempt(run, runStore)
  options.onExecution?.()
  let response: ScheduleRunRecord["response"]
  try {
    const value = await runInRunScopes(() => runWithScheduleWaitUntil(
      waitUntil => options.definition.handler(toHandlerContext(run, attempt, waitUntil)),
      options.waitUntil,
    ))
    response = await serializeResponse(toResponse(value))
  }
  catch (error) {
    const failed = await failRun(run, attempt, error, runStore)
    await emitRunFailed({ event: "schedule.failed", schedule: failed.scheduleId, runId: failed.id, error: toRunFailedError(error), failedAt: (failed.completedAt ?? new Date()).toISOString() })
    if (options.captureHandlerFailure) return failed
    throw error
  }
  return await completeRun(run, attempt, response, runStore)
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<ScheduleRunRecord> {
  return await executeSchedule({
    ...(options.claimed ? { claimed: true } : {}),
    definition: options.definition,
    onExecution: options.onExecution,
    scheduleId: options.name,
    source: "static",
    scheduledAt: options.scheduledAt,
    target: options.name,
    waitUntil: options.waitUntil,
  })
}

function isStaticScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return isObjectRecord(value)
    && Object.hasOwn(value, "handler")
    && typeof value.handler === "function"
    && Object.hasOwn(value, "cron")
}

export async function loadStaticScheduleDefinition(name: string, registry: ScheduleDefinitionRegistry): Promise<ScheduleDefinition | undefined> {
  const entry = Object.hasOwn(registry, name) ? registry[name] : undefined
  const loaded: unknown = typeof entry === "function" ? await entry() : undefined
  const record = isObjectRecord(loaded) ? loaded : undefined
  const definition = record && isStaticScheduleDefinition(record)
    ? record
    : record && Object.hasOwn(record, "default") && isStaticScheduleDefinition(record.default)
      ? record.default
      : undefined
  return definition
}

export async function resolveManualSchedule(registry: ScheduleDefinitionRegistry, name: string): Promise<ScheduleDefinition> {
  const definition = typeof name === "string" && name ? await loadStaticScheduleDefinition(name, registry) : undefined
  if (!definition) {
    throw createScheduleError("SCHEDULE_DEFINITION_NOT_FOUND")
  }
  if (definition.options?.manual !== true) {
    throw createScheduleError("SCHEDULE_MANUAL_RUN_DISABLED")
  }
  return definition
}

export function executeManualSchedule(definition: ScheduleDefinition, name: string, scheduledAt: Date): Promise<ScheduleRunRecord> {
  return executeSchedule({
    captureHandlerFailure: true,
    definition,
    runIdSuffix: randomId("manual"),
    scheduleId: name,
    scheduledAt,
    source: "manual",
    target: name,
  })
}

/** Runs a manually dispatchable static Schedule Definition of `registry` immediately. */
export async function runScheduleFrom(registry: ScheduleDefinitionRegistry, name: string, options: RunScheduleOptions = {}): Promise<ScheduleRunRecord> {
  const definition = await resolveManualSchedule(registry, name)
  return await executeManualSchedule(definition, name, parseScheduledAt(options.scheduledAt))
}
