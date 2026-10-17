import type { ScheduleDefinition, ScheduleDefinitionInput, ScheduleDefinitionOptions, ScheduleHandler } from "./types.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

const cronFieldPattern = /^[^\s]+$/
const scheduleDefinitionKeys = new Set(["manual", "cron", "handler"])
const scheduleOptionsKeys = new Set(["manual"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isCronString(value: unknown): value is string {
  return value !== null && value !== undefined && String(value) === value
}

function assertOwnDefinitionFields(input: Record<string, unknown>, keys: ReadonlySet<string>, message: string, diagnostic: (options: { message: string }) => Error): void {
  const inheritedKey = [...keys].find(key => key in input && !Object.hasOwn(input, key))
  if (inheritedKey) {
    throw diagnostic({ message: `${message} The "${inheritedKey}" option must be an own property.` })
  }
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

export function defineSchedule<TResult = unknown>(cron: string, handler: ScheduleHandler<TResult>, options?: ScheduleDefinitionOptions): ScheduleDefinition<TResult>
export function defineSchedule<TResult = unknown>(input: ScheduleDefinitionInput<TResult>): ScheduleDefinition<TResult>
export function defineSchedule<TResult = unknown>(cronOrInput: string | ScheduleDefinitionInput<TResult>, handler?: ScheduleHandler<TResult>, options: ScheduleDefinitionOptions = {}): ScheduleDefinition<TResult> {
  if (!isPlainObject(options)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` options must be an object." })
  }
  assertOwnDefinitionFields(options, scheduleOptionsKeys, "`defineSchedule()` does not accept inherited options.", scheduleErrorDiagnostics.SCHEDULE_C0004)
  if (!isCronString(cronOrInput) && !isPlainObject(cronOrInput)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` expects an object with `cron` and `handler`." })
  }
  const input = isPlainObject(cronOrInput) ? cronOrInput : { ...options, cron: cronOrInput, handler: handler! }
  if (!isPlainObject(input)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` expects an object with `cron` and `handler`." })
  }

  if (!Object.hasOwn(input, "cron") || !Object.hasOwn(input, "handler")) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` expects an object with `cron` and `handler`." })
  }
  assertOwnDefinitionFields(input, scheduleDefinitionKeys, "`defineSchedule()` does not accept inherited options.", scheduleErrorDiagnostics.SCHEDULE_C0004)

  const unknownKey = Object.keys(input).find(key => !scheduleDefinitionKeys.has(key))
  if (unknownKey) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0004({ message: `\`defineSchedule()\` does not support the "${unknownKey}" option.` })
  }

  validateCron(input.cron)

  if (typeof input.handler !== "function") {
    throw scheduleErrorDiagnostics.SCHEDULE_C0005({ message: "`defineSchedule()` requires a schedule handler." })
  }

  if (input.manual !== undefined && input.manual !== true && input.manual !== false) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0006({ message: "`defineSchedule()` manual must be a boolean." })
  }

  const definition: ScheduleDefinition<TResult> = {
    cron: input.cron,
    handler: input.handler,
  }
  if (input.manual !== undefined) {
    definition.options = { manual: input.manual }
  }
  return definition
}
