import { randomId } from "@vite-hub/internal/runtime/random"

import { ScheduleError } from "../errors.ts"
import { isRuntimeScheduleDue } from "./due.ts"
import { getRuntimeScheduleStore, getScheduleRunStore, loadScheduleDefinition } from "./state.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleWake, ScheduleDefinition, ScheduleRunAttemptRecord, ScheduleRunContext, ScheduleRunError, ScheduleRunRecord, ScheduleRunStore, ScheduleTargetName } from "../types.ts"

interface ExecuteScheduleOptions {
  definition: ScheduleDefinition
  runStore?: ScheduleRunStore
  scheduleId: string
  source?: "direct" | "runtime" | "static"
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
  requireDue?: boolean
  runtimeScheduleStore?: RuntimeScheduleStore
  scheduledAt?: Date
  scheduleRunStore?: ScheduleRunStore
}

interface ExecuteRuntimeScheduleWakeOptions {
  runtimeScheduleStore: RuntimeScheduleStore
  scheduleRunStore: ScheduleRunStore
}

function assertRuntimeExecuteOptionsObject(options: unknown): asserts options is ExecuteRuntimeScheduleOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new ScheduleError("Runtime Schedule execute options must be a schedule id or options object.", {
      code: "SCHEDULE_INVALID_INPUT",
      details: { options },
      httpStatus: 400,
    })
  }
}

function normalizeRunSource(source: ExecuteScheduleOptions["source"]): NonNullable<ExecuteScheduleOptions["source"]> {
  return source ?? "direct"
}

function toRunId(source: ExecuteScheduleOptions["source"], scheduleId: string, scheduledAt: Date): string {
  return `srun_${normalizeRunSource(source)}_${encodeURIComponent(scheduleId)}_${scheduledAt.toISOString()}`
}

function validateScheduledAt(scheduledAt: Date): Date {
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
    throw new ScheduleError("Schedule Run scheduledAt must be a valid Date.", {
      code: "SCHEDULE_INVALID_SCHEDULED_AT",
      details: { scheduledAt },
      httpStatus: 400,
    })
  }
  return scheduledAt
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
  const store = options.runStore ?? getScheduleRunStore()
  const id = toRunId(options.source, options.scheduleId, options.scheduledAt)
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

async function completeRun(run: ScheduleRunRecord, attempt: ScheduleRunAttemptRecord, store: ScheduleRunStore = getScheduleRunStore()): Promise<ScheduleRunRecord> {
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

export async function createScheduleRun(options: Omit<ExecuteScheduleOptions, "definition">): Promise<ScheduleRunRecord> {
  const scheduledAt = validateScheduledAt(options.scheduledAt ?? new Date())
  return (await createOrGetRun({ ...options, scheduledAt })).run
}

export async function executeSchedule(options: ExecuteScheduleOptions): Promise<ScheduleRunRecord> {
  const scheduledAt = validateScheduledAt(options.scheduledAt ?? new Date())
  const { created, run } = await createOrGetRun({ ...options, scheduledAt })

  // v1 policy is intentionally fixed: the deterministic run id dedupes repeated
  // delivery for one scheduled occurrence, and an existing run never overlaps or retries.
  if (!created) {
    return run
  }

  const runStore = options.runStore ?? getScheduleRunStore()
  const attempt = await startAttempt(run, runStore)
  try {
    await options.definition.handler(toHandlerContext(run, attempt))
    return await completeRun(run, attempt, runStore)
  }
  catch (error) {
    await failRun(run, attempt, error, runStore)
    throw error
  }
}

export async function executeStaticSchedule(options: ExecuteStaticScheduleOptions): Promise<ScheduleRunRecord> {
  return await executeSchedule({
    definition: options.definition,
    scheduleId: options.name,
    source: "static",
    scheduledAt: options.scheduledAt,
    target: options.name,
  })
}

async function loadRequiredRuntimeSchedule(id: string, store: RuntimeScheduleStore = getRuntimeScheduleStore()): Promise<RuntimeScheduleRecord> {
  const schedule = await store.get(id)
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
  const runtimeOptions = typeof options === "string" ? { id: options } : options
  assertRuntimeExecuteOptionsObject(runtimeOptions)
  const id = runtimeOptions.id
  const scheduledAt = validateScheduledAt(runtimeOptions.scheduledAt ?? new Date())
  const runtimeScheduleStore = runtimeOptions.runtimeScheduleStore
  const scheduleRunStore = runtimeOptions.scheduleRunStore
  const existingRun = await (scheduleRunStore ?? getScheduleRunStore()).getRun(toRunId("runtime", id, scheduledAt))
  if (existingRun) {
    return existingRun
  }

  const schedule = await loadRequiredRuntimeSchedule(id, runtimeScheduleStore)
  if (!schedule.enabled) {
    throw new ScheduleError(`Runtime Schedule is disabled: ${id}`, {
      code: "SCHEDULE_DISABLED",
      details: { id },
      httpStatus: 409,
    })
  }
  if (runtimeOptions.requireDue && !isRuntimeScheduleDue(schedule, scheduledAt)) {
    throw new ScheduleError(`Runtime Schedule is not due: ${id}`, {
      code: "SCHEDULE_NOT_DUE",
      details: { id, scheduledAt },
      httpStatus: 409,
    })
  }
  const definition = await loadScheduleDefinition(schedule.target)
  if (!definition) {
    throw new ScheduleError(`Unknown Runtime Schedule target: ${schedule.target}`, {
      code: "SCHEDULE_TARGET_NOT_FOUND",
      details: { target: schedule.target },
      httpStatus: 404,
    })
  }
  if (definition.options?.allowRuntimeSchedules !== true) {
    throw new ScheduleError(`Runtime Schedule target is not eligible: ${schedule.target}`, {
      code: "SCHEDULE_TARGET_NOT_ELIGIBLE",
      details: { target: schedule.target },
      httpStatus: 400,
    })
  }

  return await executeSchedule({
    definition,
    runStore: scheduleRunStore,
    scheduleId: schedule.id,
    source: "runtime",
    scheduledAt,
    target: schedule.target,
  })
}

export async function executeRuntimeScheduleWake(input: RuntimeScheduleWake, options: ExecuteRuntimeScheduleWakeOptions): Promise<void> {
  await executeRuntimeSchedule({
    id: input.scheduleId,
    requireDue: true,
    runtimeScheduleStore: options.runtimeScheduleStore,
    scheduledAt: input.scheduledAt,
    scheduleRunStore: options.scheduleRunStore,
  })
}
