import type { ScheduleDefinition, ScheduleDefinitionOptions, ScheduleHandler } from "./types.ts"

const cronFieldPattern = /^[^\s]+$/

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

export function defineSchedule<TResult = unknown>(
  cron: string,
  handler: ScheduleHandler<TResult>,
  options?: ScheduleDefinitionOptions,
): ScheduleDefinition<TResult> {
  validateCron(cron)

  if (typeof handler !== "function") {
    throw new TypeError("`defineSchedule()` requires a schedule handler.")
  }

  if (typeof options !== "undefined" && !isPlainObject(options)) {
    throw new TypeError("`defineSchedule()` options must be a plain object.")
  }

  if (typeof options?.id !== "undefined" && (typeof options.id !== "string" || options.id.length === 0)) {
    throw new TypeError("`defineSchedule()` options.id must be a non-empty string.")
  }

  return { cron, handler, options }
}
