import type { ScheduleDefinition, ScheduleDefinitionInput, ScheduleTargetDefinition, ScheduleTargetDefinitionInput } from "./types.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

const cronFieldPattern = /^[^\s]+$/
const scheduleDefinitionKeys = new Set(["allowRuntimeSchedules", "cron", "handler"])
const scheduleTargetDefinitionKeys = new Set(["handler"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validateCron(cron: string): void {
  if (typeof cron !== "string" || cron.trim() !== cron || cron.length === 0) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0001({ message: "`defineSchedule()` requires a cron string." })
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field))) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0002({ message: "`defineSchedule()` cron must be a five-field UTC cron expression." })
  }
}

export function defineSchedule<TResult = unknown>(input: ScheduleDefinitionInput<TResult>): ScheduleDefinition<TResult> {
  if (!isPlainObject(input)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` expects an object with `cron` and `handler`." })
  }

  const unknownKey = Object.keys(input).find(key => !scheduleDefinitionKeys.has(key))
  if (unknownKey) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0004({ message: `\`defineSchedule()\` does not support the "${unknownKey}" option.` })
  }

  validateCron(input.cron)

  if (typeof input.handler !== "function") {
    throw scheduleErrorDiagnostics.SCHEDULE_C0005({ message: "`defineSchedule()` requires a schedule handler." })
  }

  if (typeof input.allowRuntimeSchedules !== "undefined" && typeof input.allowRuntimeSchedules !== "boolean") {
    throw scheduleErrorDiagnostics.SCHEDULE_C0006({ message: "`defineSchedule()` allowRuntimeSchedules must be a boolean." })
  }

  const definition: ScheduleDefinition<TResult> = {
    cron: input.cron,
    handler: input.handler,
  }
  if (typeof input.allowRuntimeSchedules !== "undefined") {
    definition.options = { allowRuntimeSchedules: input.allowRuntimeSchedules }
  }
  return definition
}

export function defineScheduleTarget<TInput = unknown, TResult = unknown>(input: ScheduleTargetDefinitionInput<TInput, TResult>): ScheduleTargetDefinition<TInput, TResult> {
  if (!isPlainObject(input)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0007({ message: "`defineScheduleTarget()` expects an object with `handler`." })
  }

  const unknownKey = Object.keys(input).find(key => !scheduleTargetDefinitionKeys.has(key))
  if (unknownKey) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0008({ message: `\`defineScheduleTarget()\` does not support the "${unknownKey}" option.` })
  }

  if (typeof input.handler !== "function") {
    throw scheduleErrorDiagnostics.SCHEDULE_C0009({ message: "`defineScheduleTarget()` requires a schedule handler." })
  }

  return {
    handler: input.handler,
    options: { allowRuntimeSchedules: true },
  }
}
