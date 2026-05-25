import type { ScheduleDefinition, ScheduleDefinitionInput } from "./types.ts"

const cronFieldPattern = /^[^\s]+$/
const scheduleDefinitionKeys = new Set(["cron", "handler"])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function validateCron(cron: string): void {
  if (typeof cron !== "string" || cron.trim() !== cron || cron.length === 0) {
    throw new TypeError("`defineSchedule()` requires a cron string.")
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field))) {
    throw new TypeError("`defineSchedule()` cron must be a five-field UTC cron expression.")
  }
}

export function defineSchedule<TResult = unknown>(input: ScheduleDefinitionInput<TResult>): ScheduleDefinition<TResult> {
  if (!isPlainObject(input)) {
    throw new TypeError("`defineSchedule()` expects an object with `cron` and `handler`.")
  }

  const unknownKey = Object.keys(input).find(key => !scheduleDefinitionKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineSchedule()\` does not support the "${unknownKey}" option.`)
  }

  validateCron(input.cron)

  if (typeof input.handler !== "function") {
    throw new TypeError("`defineSchedule()` requires a schedule handler.")
  }

  return { cron: input.cron, handler: input.handler }
}
