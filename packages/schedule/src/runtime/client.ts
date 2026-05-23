import { randomId } from "@vitehub/internal/runtime/random"

import { ScheduleError } from "../errors.ts"
import { getRuntimeScheduleStore, loadScheduleDefinition } from "./state.ts"

import type { RuntimeScheduleCreateInput, RuntimeScheduleRecord, RuntimeScheduleUpdateInput, ScheduleTargetName } from "../types.ts"

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

export function validateRuntimeScheduleCron(cron: string): void {
  if (typeof cron !== "string" || cron.trim() !== cron || cron.length === 0) {
    throw new ScheduleError("Runtime Schedule cron must be a five-field UTC cron expression.", {
      code: "SCHEDULE_INVALID_CRON",
      details: { cron },
      httpStatus: 400,
    })
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduleError("Runtime Schedule cron must be a five-field UTC cron expression.", {
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

async function assertRuntimeTarget(target: ScheduleTargetName): Promise<void> {
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

async function validateCreateInput(input: RuntimeScheduleCreateInput): Promise<void> {
  await assertRuntimeTarget(input.target)
  validateRuntimeScheduleCron(input.cron)
}

async function validateUpdateInput(input: RuntimeScheduleUpdateInput): Promise<void> {
  if (input.target !== undefined) {
    await assertRuntimeTarget(input.target)
  }
  if (input.cron !== undefined) {
    validateRuntimeScheduleCron(input.cron)
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
      id: input.id || randomId("sched"),
      target: input.target,
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
  async list(): Promise<RuntimeScheduleRecord[]> {
    return await getRuntimeScheduleStore().list()
  },
  async update<TTarget extends ScheduleTargetName>(id: string, input: RuntimeScheduleUpdateInput<TTarget>): Promise<RuntimeScheduleRecord> {
    return await updateRuntimeSchedule(id, input)
  },
}
