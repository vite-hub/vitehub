import { randomId } from "@vite-hub/internal/runtime/random"

import { assertRuntimeScheduleId, invalidScheduleValueDetails, createScheduleError } from "../errors.ts"
import { isRuntimeScheduleDue } from "./due.ts"
import { getRuntimeScheduleStore, getScheduleRunStore, loadScheduleDefinition } from "./state.ts"
import { createLocalWaitUntil } from "./wait-until.ts"

import type { RuntimeScheduleRecord, RuntimeScheduleStore, RuntimeScheduleWake, ScheduleDefinition, ScheduleRegistryDefinition, ScheduleRunAttemptRecord, ScheduleRunContext, ScheduleRunError, ScheduleRunRecord, ScheduleRunStore, ScheduleTargetName } from "../types.ts"

interface ExecuteScheduleOptions {
  definition: ScheduleRegistryDefinition
  input?: unknown
  runStore?: ScheduleRunStore
  scheduleId: string
  source?: "direct" | "runtime" | "static"
  scheduledAt?: Date
  target: ScheduleTargetName
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

interface ExecuteStaticScheduleOptions {
  cron: string
  definition: ScheduleDefinition
  name: string
  scheduledAt?: Date
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

interface ExecuteRuntimeScheduleOptions {
  id: string
  requireDue?: boolean
  runtimeScheduleStore?: RuntimeScheduleStore
  scheduledAt?: Date
  scheduleRunStore?: ScheduleRunStore
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

interface ExecuteRuntimeScheduleWakeOptions {
  runtimeScheduleStore: RuntimeScheduleStore
  scheduleRunStore: ScheduleRunStore
  waitUntil?: (promise: PromiseLike<unknown>) => void
}

function assertRuntimeExecuteOptionsObject(options: unknown): asserts options is ExecuteRuntimeScheduleOptions {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw createScheduleError("SCHEDULE_INVALID_INPUT", {
      details: invalidScheduleValueDetails("options", options),
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
    throw createScheduleError("SCHEDULE_INVALID_SCHEDULED_AT", {
      details: invalidScheduleValueDetails("scheduledAt", scheduledAt),
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
    throw createScheduleError("SCHEDULE_RUN_NOT_FOUND")
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

function toHandlerContext(
  run: ScheduleRunRecord,
  attempt: ScheduleRunAttemptRecord,
  input: unknown,
  waitUntil: (promise: PromiseLike<unknown>) => void,
): ScheduleRunContext {
  return {
    attemptId: attempt.id,
    id: run.id,
    ...(input !== undefined ? { input } : {}),
    runId: run.id,
    scheduleId: run.scheduleId,
    scheduledAt: run.scheduledAt,
    target: run.target,
    waitUntil,
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

export async function createScheduleRun(options: Omit<ExecuteScheduleOptions, "definition" | "waitUntil">): Promise<ScheduleRunRecord> {
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
  const localWaitUntil = createLocalWaitUntil()
  const waitUntil = options.waitUntil ?? localWaitUntil.waitUntil
  try {
    await options.definition.handler(toHandlerContext(run, attempt, options.input, waitUntil))
    if (!options.waitUntil) await localWaitUntil.flush()
    return await completeRun(run, attempt, runStore)
  }
  catch (error) {
    if (!options.waitUntil) {
      try {
        await localWaitUntil.flush()
      }
      catch {
        // Preserve the handler error after all locally owned work settles.
      }
    }
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
    waitUntil: options.waitUntil,
  })
}

async function loadRequiredRuntimeSchedule(id: string, store: RuntimeScheduleStore = getRuntimeScheduleStore()): Promise<RuntimeScheduleRecord> {
  const schedule = await store.get(id)
  if (!schedule) {
    throw createScheduleError("SCHEDULE_NOT_FOUND")
  }
  return schedule
}

export async function executeRuntimeSchedule(options: ExecuteRuntimeScheduleOptions | string): Promise<ScheduleRunRecord> {
  const runtimeOptions = typeof options === "string" ? { id: options } : options
  assertRuntimeExecuteOptionsObject(runtimeOptions)
  assertRuntimeScheduleId(runtimeOptions.id)
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
    throw createScheduleError("SCHEDULE_DISABLED")
  }
  if (runtimeOptions.requireDue && !isRuntimeScheduleDue(schedule, scheduledAt)) {
    throw createScheduleError("SCHEDULE_NOT_DUE")
  }
  const definition = await loadScheduleDefinition(schedule.target)
  if (!definition) {
    throw createScheduleError("SCHEDULE_TARGET_NOT_FOUND")
  }
  if (definition.options?.allowRuntimeSchedules !== true) {
    throw createScheduleError("SCHEDULE_TARGET_NOT_ELIGIBLE")
  }

  return await executeSchedule({
    definition,
    input: schedule.input,
    runStore: scheduleRunStore,
    scheduleId: schedule.id,
    source: "runtime",
    scheduledAt,
    target: schedule.target,
    waitUntil: runtimeOptions.waitUntil,
  })
}

export async function executeRuntimeScheduleWake(input: RuntimeScheduleWake, options: ExecuteRuntimeScheduleWakeOptions): Promise<void> {
  await executeRuntimeSchedule({
    id: input.scheduleId,
    requireDue: true,
    runtimeScheduleStore: options.runtimeScheduleStore,
    scheduledAt: input.scheduledAt,
    scheduleRunStore: options.scheduleRunStore,
    waitUntil: options.waitUntil,
  })
}
