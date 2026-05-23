import { randomId } from "@vitehub/internal/runtime/random"

import { ScheduleError } from "../errors.ts"
import { getRuntimeScheduleStore, getScheduleRunStore, loadScheduleDefinition } from "./state.ts"

import type { RuntimeScheduleRecord, ScheduleDefinition, ScheduleRunAttemptRecord, ScheduleRunContext, ScheduleRunError, ScheduleRunRecord, ScheduleTargetName } from "../types.ts"

interface ExecuteScheduleOptions {
  definition: ScheduleDefinition
  scheduleId: string
  scheduledAt?: Date
  target: ScheduleTargetName
}

interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
}

interface ExecuteRuntimeScheduleOptions {
  id: string
  scheduledAt?: Date
}

function toRunId(scheduleId: string, scheduledAt: Date): string {
  return `srun_${encodeURIComponent(scheduleId)}_${scheduledAt.toISOString()}`
}

function toRunError(error: unknown): ScheduleRunError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}

function requireUpdatedRun(run: ScheduleRunRecord | undefined): ScheduleRunRecord {
  if (!run) {
    throw new ScheduleError("Schedule Run bookkeeping update failed.", {
      code: "SCHEDULE_RUN_NOT_FOUND",
      httpStatus: 500,
    })
  }
  return run
}

async function createOrGetRun(options: Omit<ExecuteScheduleOptions, "definition"> & { scheduledAt: Date }): Promise<{ created: boolean, run: ScheduleRunRecord }> {
  const store = getScheduleRunStore()
  const id = toRunId(options.scheduleId, options.scheduledAt)
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

async function startAttempt(run: ScheduleRunRecord): Promise<ScheduleRunAttemptRecord> {
  const store = getScheduleRunStore()
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

function toHandlerContext(run: ScheduleRunRecord, attempt: ScheduleRunAttemptRecord): ScheduleRunContext {
  return {
    attemptId: attempt.id,
    id: run.id,
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduledAt: run.scheduledAt,
    target: run.target,
  }
}

async function completeRun(run: ScheduleRunRecord, attempt: ScheduleRunAttemptRecord): Promise<ScheduleRunRecord> {
  const store = getScheduleRunStore()
  const now = new Date()
  await store.updateAttempt(attempt.id, {
    completedAt: now,
    status: "succeeded",
    updatedAt: now,
  })
  return requireUpdatedRun(await store.updateRun(run.id, {
    completedAt: now,
    status: "succeeded",
    updatedAt: now,
  }))
}

async function failRun(run: ScheduleRunRecord, attempt: ScheduleRunAttemptRecord, error: unknown): Promise<ScheduleRunRecord> {
  const store = getScheduleRunStore()
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

export async function createScheduleRun(options: Omit<ExecuteScheduleOptions, "definition">): Promise<ScheduleRunRecord> {
  const scheduledAt = options.scheduledAt ?? new Date()
  return (await createOrGetRun({ ...options, scheduledAt })).run
}

export async function executeSchedule(options: ExecuteScheduleOptions): Promise<ScheduleRunRecord> {
  const scheduledAt = options.scheduledAt ?? new Date()
  const { created, run } = await createOrGetRun({ ...options, scheduledAt })

  // v1 policy is intentionally fixed: the deterministic run id dedupes repeated
  // delivery for one scheduled occurrence, and an existing run never overlaps or retries.
  if (!created) {
    return run
  }

  const attempt = await startAttempt(run)
  try {
    await options.definition.handler(toHandlerContext(run, attempt))
    return await completeRun(run, attempt)
  }
  catch (error) {
    await failRun(run, attempt, error)
    throw error
  }
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<ScheduleRunRecord> {
  return await executeSchedule({
    definition: options.definition,
    scheduleId: options.definition.options?.id ?? options.name,
    scheduledAt: options.scheduledAt,
    target: options.name,
  })
}

async function loadRequiredRuntimeSchedule(id: string): Promise<RuntimeScheduleRecord> {
  const schedule = await getRuntimeScheduleStore().get(id)
  if (!schedule) {
    throw new ScheduleError(`Runtime Schedule not found: ${id}`, {
      code: "SCHEDULE_NOT_FOUND",
      details: { id },
      httpStatus: 404,
    })
  }
  return schedule
}

export async function executeRuntimeSchedule(options: ExecuteRuntimeScheduleOptions | string): Promise<ScheduleRunRecord> {
  const id = typeof options === "string" ? options : options.id
  const scheduledAt = typeof options === "string" ? undefined : options.scheduledAt
  const schedule = await loadRequiredRuntimeSchedule(id)
  const definition = await loadScheduleDefinition(schedule.target)
  if (!definition) {
    throw new ScheduleError(`Unknown Runtime Schedule target: ${schedule.target}`, {
      code: "SCHEDULE_TARGET_NOT_FOUND",
      details: { target: schedule.target },
      httpStatus: 404,
    })
  }

  return await executeSchedule({
    definition,
    scheduleId: schedule.id,
    scheduledAt,
    target: schedule.target,
  })
}
