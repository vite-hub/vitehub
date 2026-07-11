import { randomId } from "@vite-hub/internal/runtime/random"

import { ScheduleError } from "../errors.ts"
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

const runtimeScheduleCreateInputKeys = new Set(["cron", "enabled", "id", "target", "timeZone"])
const runtimeScheduleUpdateInputKeys = new Set(["cron", "enabled", "target", "timeZone"])

function isIanaTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || (timeZone !== "UTC" && !timeZone.includes("/"))) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone })
    return true
  }
  catch {
    return false
  }
}

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
    throw new ScheduleError("Runtime Schedule cron must be a five-field cron expression.", {
      code: "SCHEDULE_INVALID_CRON",
      details: { cron },
      httpStatus: 400,
    })
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduleError("Runtime Schedule cron must be a five-field cron expression.", {
      code: "SCHEDULE_INVALID_CRON",
      details: { cron },
      httpStatus: 400,
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
    throw new ScheduleError(`Invalid Runtime Schedule cron expression: ${cron}`, {
      code: "SCHEDULE_INVALID_CRON",
      details: { cron },
      httpStatus: 400,
    })
  }
}

function validateRuntimeScheduleTimeZone(timeZone: unknown): void {
  if (!isIanaTimeZone(timeZone)) {
    throw new ScheduleError("Runtime Schedule timeZone must be a valid IANA time zone.", {
      code: "SCHEDULE_INVALID_TIME_ZONE",
      details: { timeZone },
      httpStatus: 400,
    })
  }
}

async function assertRuntimeTarget(target: unknown): Promise<void> {
  if (typeof target !== "string" || !target.trim()) {
    throw new ScheduleError("Runtime Schedule target must be a non-empty string.", {
      code: "SCHEDULE_INVALID_TARGET",
      details: { target },
      httpStatus: 400,
    })
  }

  const definition = await loadScheduleDefinition(target)
  if (!definition) {
    throw new ScheduleError(`Unknown Runtime Schedule target: ${target}`, {
      code: "SCHEDULE_TARGET_NOT_FOUND",
      details: { target },
      httpStatus: 404,
    })
  }

  if (definition.options?.allowRuntimeSchedules !== true) {
    throw new ScheduleError(`Schedule target is not runtime-schedule eligible: ${target}`, {
      code: "SCHEDULE_TARGET_NOT_ELIGIBLE",
      details: { target },
      httpStatus: 400,
    })
  }
}

function assertRuntimeScheduleInputObject(input: unknown, operation: "create" | "update"): asserts input is Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ScheduleError(`Runtime Schedule ${operation} input must be an object.`, {
      code: "SCHEDULE_INVALID_INPUT",
      details: { input },
      httpStatus: 400,
    })
  }
}

function assertRuntimeScheduleInputKeys(input: Record<string, unknown>, allowed: Set<string>, operation: "create" | "update"): void {
  const unknownKey = Object.keys(input).find(key => !allowed.has(key))
  if (unknownKey) {
    throw new ScheduleError(`Runtime Schedule ${operation} does not support "${unknownKey}".`, {
      code: "SCHEDULE_INVALID_INPUT",
      details: { key: unknownKey },
      httpStatus: 400,
    })
  }
}

async function validateCreateInput(input: RuntimeScheduleCreateInput): Promise<void> {
  assertRuntimeScheduleInputObject(input, "create")
  assertRuntimeScheduleInputKeys(input, runtimeScheduleCreateInputKeys, "create")
  await assertRuntimeTarget(input.target)
  validateRuntimeScheduleCron(input.cron)
  if (input.id !== undefined && (typeof input.id !== "string" || !input.id.trim())) {
    throw new ScheduleError("Runtime Schedule id must be a non-empty string when provided.", {
      code: "SCHEDULE_INVALID_ID",
      details: { id: input.id },
      httpStatus: 400,
    })
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ScheduleError("Runtime Schedule enabled must be a boolean when provided.", {
      code: "SCHEDULE_INVALID_ENABLED",
      details: { enabled: input.enabled },
      httpStatus: 400,
    })
  }
  if (input.timeZone !== undefined) {
    validateRuntimeScheduleTimeZone(input.timeZone)
  }
}

async function validateUpdateInput(input: RuntimeScheduleUpdateInput): Promise<void> {
  assertRuntimeScheduleInputObject(input, "update")
  assertRuntimeScheduleInputKeys(input, runtimeScheduleUpdateInputKeys, "update")
  if (input.target !== undefined) {
    await assertRuntimeTarget(input.target)
  }
  if (input.cron !== undefined) {
    validateRuntimeScheduleCron(input.cron)
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ScheduleError("Runtime Schedule enabled must be a boolean when provided.", {
      code: "SCHEDULE_INVALID_ENABLED",
      details: { enabled: input.enabled },
      httpStatus: 400,
    })
  }
  if (input.timeZone !== undefined) {
    validateRuntimeScheduleTimeZone(input.timeZone)
  }
}

async function updateRuntimeSchedule<TTarget extends ScheduleTargetName>(id: string, input: RuntimeScheduleUpdateInput<TTarget>): Promise<RuntimeScheduleRecord> {
  await validateUpdateInput(input)
  const updated = await getRuntimeScheduleStore().update(id, {
    ...input,
    updatedAt: new Date(),
  })
  if (!updated) {
    throw new ScheduleError(`Runtime Schedule not found: ${id}`, {
      code: "SCHEDULE_NOT_FOUND",
      details: { id },
      httpStatus: 404,
    })
  }
  return updated
}

export const schedules = {
  async create<TTarget extends ScheduleTargetName>(input: RuntimeScheduleCreateInput<TTarget>): Promise<RuntimeScheduleRecord> {
    await validateCreateInput(input)
    const now = new Date()
    return await getRuntimeScheduleStore().create({
      createdAt: now,
      cron: input.cron,
      enabled: input.enabled ?? true,
      id: input.id ?? randomId("sched"),
      target: input.target,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      updatedAt: now,
    })
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
  async update<TTarget extends ScheduleTargetName>(id: string, input: RuntimeScheduleUpdateInput<TTarget>): Promise<RuntimeScheduleRecord> {
    return await updateRuntimeSchedule(id, input)
  },
}
