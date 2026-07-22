import { randomId } from "@vite-hub/internal/runtime/random"
import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"

import { assertRuntimeScheduleId, invalidScheduleValueDetails, createScheduleError } from "../errors.ts"
import { executeRuntimeSchedule } from "./execute.ts"
import { getRuntimeScheduleStore, getScheduleRunStore, loadScheduleDefinition } from "./state.ts"

import type { RuntimeScheduleCreateInput, RuntimeScheduleRecord, RuntimeScheduleUpdateInput, ScheduleRunAttemptRecord, ScheduleRunRecord, ScheduleTargetName } from "../types.ts"

const cronRange = {
  dayOfMonth: { max: 31, min: 1 },
  dayOfWeek: { max: 7, min: 0 },
  hour: { max: 23, min: 0 },
  minute: { max: 59, min: 0 },
  month: { max: 12, min: 1 },
}

const cronFieldRanges = [
  cronRange.minute,
  cronRange.hour,
  cronRange.dayOfMonth,
  cronRange.month,
  cronRange.dayOfWeek,
] as const

const runtimeScheduleCreateInputKeys = new Set(["cron", "enabled", "id", "input", "target", "timeZone"])
const runtimeScheduleUpdateInputKeys = new Set(["cron", "enabled", "input", "target", "timeZone"])

function parseCronNumber(value: string, range: { min: number, max: number }): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("not a number")
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new Error("out of range")
  }
  return parsed
}

function validateCronPart(part: string, range: { min: number, max: number }): void {
  const [value, step, extra] = part.split("/")
  if (extra !== undefined || value === undefined || value.length === 0) {
    throw new Error("invalid step")
  }
  if (step !== undefined) {
    const parsedStep = parseCronNumber(step, { max: range.max, min: 1 })
    if (parsedStep < 1) {
      throw new Error("invalid step")
    }
  }
  if (value === "*") {
    return
  }

  const [start, end, extraRange] = value.split("-")
  if (extraRange !== undefined || start === undefined || start.length === 0) {
    throw new Error("invalid range")
  }
  const parsedStart = parseCronNumber(start, range)
  if (end === undefined) {
    return
  }

  const parsedEnd = parseCronNumber(end, range)
  if (parsedEnd < parsedStart) {
    throw new Error("invalid range")
  }
}

export function validateRuntimeScheduleCron(cron: unknown): void {
  if (typeof cron !== "string" || cron.trim() !== cron || cron.length === 0) {
    throw createScheduleError("SCHEDULE_INVALID_CRON", {
      details: invalidScheduleValueDetails("cron", cron),
    })
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5) {
    throw createScheduleError("SCHEDULE_INVALID_CRON", {
      details: invalidScheduleValueDetails("cron", cron),
    })
  }

  try {
    fields.forEach((field, index) => {
      if (field.length === 0) {
        throw new Error("empty field")
      }
      for (const part of field.split(",")) {
        validateCronPart(part, cronFieldRanges[index]!)
      }
    })
  }
  catch {
    throw createScheduleError("SCHEDULE_INVALID_CRON", {
      details: invalidScheduleValueDetails("cron", cron),
    })
  }
}

function validateRuntimeScheduleTimeZone(timeZone: unknown): void {
  if (!isIanaTimeZone(timeZone)) {
    throw createScheduleError("SCHEDULE_INVALID_TIME_ZONE", {
      details: invalidScheduleValueDetails("timeZone", timeZone),
    })
  }
}

async function assertRuntimeTarget(target: unknown): Promise<void> {
  if (typeof target !== "string" || !target.trim()) {
    throw createScheduleError("SCHEDULE_INVALID_TARGET", {
      details: invalidScheduleValueDetails("target", target),
    })
  }

  const definition = await loadScheduleDefinition(target)
  if (!definition) {
    throw createScheduleError("SCHEDULE_TARGET_NOT_FOUND")
  }

  if (definition.options?.allowRuntimeSchedules !== true) {
    throw createScheduleError("SCHEDULE_TARGET_NOT_ELIGIBLE")
  }
}

function assertRuntimeScheduleInputObject(input: unknown): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw createScheduleError("SCHEDULE_INVALID_INPUT", {
      details: invalidScheduleValueDetails("input", input),
    })
  }
}

function assertRuntimeScheduleInputKeys(input: Record<string, unknown>, allowed: Set<string>): void {
  const unknownKey = Object.keys(input).find(key => !allowed.has(key))
  if (unknownKey) {
    throw createScheduleError("SCHEDULE_INVALID_INPUT", {
      details: invalidScheduleValueDetails("input", input),
    })
  }
}

async function validateCreateInput(input: RuntimeScheduleCreateInput): Promise<void> {
  assertRuntimeScheduleInputObject(input)
  assertRuntimeScheduleInputKeys(input, runtimeScheduleCreateInputKeys)
  await assertRuntimeTarget(input.target)
  validateRuntimeScheduleCron(input.cron)
  if (input.id !== undefined) {
    assertRuntimeScheduleId(input.id)
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw createScheduleError("SCHEDULE_INVALID_ENABLED", {
      details: invalidScheduleValueDetails("enabled", input.enabled),
    })
  }
  if (input.timeZone !== undefined) {
    validateRuntimeScheduleTimeZone(input.timeZone)
  }
}

async function validateUpdateInput(input: RuntimeScheduleUpdateInput): Promise<void> {
  assertRuntimeScheduleInputObject(input)
  assertRuntimeScheduleInputKeys(input, runtimeScheduleUpdateInputKeys)
  if (input.target !== undefined) {
    await assertRuntimeTarget(input.target)
  }
  if (input.cron !== undefined) {
    validateRuntimeScheduleCron(input.cron)
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw createScheduleError("SCHEDULE_INVALID_ENABLED", {
      details: invalidScheduleValueDetails("enabled", input.enabled),
    })
  }
  if (input.timeZone !== undefined) {
    validateRuntimeScheduleTimeZone(input.timeZone)
  }
}

async function updateRuntimeSchedule<TTarget extends ScheduleTargetName, TInput>(id: string, input: RuntimeScheduleUpdateInput<TTarget, TInput>): Promise<RuntimeScheduleRecord<TInput>> {
  assertRuntimeScheduleId(id)
  await validateUpdateInput(input)
  const updated = await getRuntimeScheduleStore().update(id, {
    ...input,
    updatedAt: new Date(),
  })
  if (!updated) {
    throw createScheduleError("SCHEDULE_NOT_FOUND")
  }
  return updated as RuntimeScheduleRecord<TInput>
}

export const schedules = {
  async create<TTarget extends ScheduleTargetName, TInput = unknown>(input: RuntimeScheduleCreateInput<TTarget, TInput>): Promise<RuntimeScheduleRecord<TInput>> {
    await validateCreateInput(input)
    const now = new Date()
    return await getRuntimeScheduleStore().create({
      createdAt: now,
      cron: input.cron,
      enabled: input.enabled ?? true,
      id: input.id ?? randomId("sched"),
      ...(input.input !== undefined ? { input: input.input } : {}),
      target: input.target,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      updatedAt: now,
    }) as RuntimeScheduleRecord<TInput>
  },
  async delete(id: string): Promise<boolean> {
    return await getRuntimeScheduleStore().delete(id)
  },
  async disable(id: string): Promise<RuntimeScheduleRecord> {
    return await updateRuntimeSchedule(id, { enabled: false })
  },
  async enable(id: string): Promise<RuntimeScheduleRecord> {
    return await updateRuntimeSchedule(id, { enabled: true })
  },
  async get(id: string): Promise<RuntimeScheduleRecord | undefined> {
    return await getRuntimeScheduleStore().get(id)
  },
  async getRun(id: string): Promise<ScheduleRunRecord | undefined> {
    return await getScheduleRunStore().getRun(id)
  },
  async list(): Promise<RuntimeScheduleRecord[]> {
    return await getRuntimeScheduleStore().list()
  },
  async listAttempts(runId: string): Promise<ScheduleRunAttemptRecord[]> {
    return await getScheduleRunStore().listAttempts(runId)
  },
  async listRuns(): Promise<ScheduleRunRecord[]> {
    return await getScheduleRunStore().listRuns()
  },
  async run(id: string, options: { scheduledAt?: Date } = {}): Promise<ScheduleRunRecord> {
    return await executeRuntimeSchedule({ id, scheduledAt: options.scheduledAt })
  },
  async update<TTarget extends ScheduleTargetName, TInput = unknown>(id: string, input: RuntimeScheduleUpdateInput<TTarget, TInput>): Promise<RuntimeScheduleRecord<TInput>> {
    return await updateRuntimeSchedule(id, input)
  },
}
