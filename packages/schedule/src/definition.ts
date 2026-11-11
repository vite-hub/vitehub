import { isIanaTimeZone } from "@vite-hub/internal/runtime/time-zone"
import { isRecord as isPlainObject } from "@vite-hub/internal/object"

import type { ScheduleDefinition, ScheduleDefinitionInput } from "./types.ts"
import { scheduleErrorDiagnostics } from "./error-diagnostics.ts"

const cronFieldPattern = /^[^\s]+$/
const scheduleDefinitionKeys = new Set(["manual", "cron", "handler", "timeZone"])

function isCronString(value: unknown): value is string {
  return value !== null && value !== undefined && String(value) === value
}

function assertOwnDefinitionFields(input: Record<string, unknown>, keys: ReadonlySet<string>, message: string, diagnostic: (options: { message: string }) => Error): void {
  const inheritedKey = [...keys].find(key => key in input && !Object.hasOwn(input, key))
  if (inheritedKey) {
    throw diagnostic({ message: `${message} The "${inheritedKey}" option must be an own property.` })
  }
}

function validateCron(cron: unknown): asserts cron is string {
  if (typeof cron !== "string" || cron.trim() !== cron || cron.length === 0) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0001({ message: "`defineSchedule()` requires a cron string." })
  }

  const fields = cron.split(/\s+/)
  if (fields.length !== 5 || !fields.every(field => cronFieldPattern.test(field))) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0002({ message: "`defineSchedule()` cron must be a five-field cron expression." })
  }
}

/** The `defineSchedule(cron, handler, options)` form was removed. Name the object form in the error. */
const positionalFormMessage = "`defineSchedule(cron, handler)` was removed. Pass one object: `defineSchedule({ cron: \"0 9 * * *\", handler })`, with `manual` and `timeZone` in the same object."

export function defineSchedule<TResult = unknown>(input: ScheduleDefinitionInput<TResult> & { cron: string }): ScheduleDefinition<TResult> & { cron: string }
export function defineSchedule<TResult = unknown>(input: ScheduleDefinitionInput<TResult>): ScheduleDefinition<TResult>
export function defineSchedule<TResult = unknown>(input: ScheduleDefinitionInput<TResult>, ...removed: unknown[]): ScheduleDefinition<TResult> {
  if (isCronString(input) || removed.length) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0007({ message: positionalFormMessage })
  }
  if (!isPlainObject(input)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` expects an object with `cron` and `handler`." })
  }

  if (!Object.hasOwn(input, "handler")) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0003({ message: "`defineSchedule()` expects an object with `handler`, and `cron` unless code starts the Schedule with `startSchedule()`." })
  }
  assertOwnDefinitionFields(input, scheduleDefinitionKeys, "`defineSchedule()` does not accept inherited options.", scheduleErrorDiagnostics.SCHEDULE_C0004)

  const unknownKey = Object.keys(input).find(key => !scheduleDefinitionKeys.has(key))
  if (unknownKey) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0004({ message: `\`defineSchedule()\` does not support the "${unknownKey}" option.` })
  }

  // Without `cron`, the Schedule runs only when code starts it with `startSchedule()`.
  const hasCron = Object.hasOwn(input, "cron")
  if (hasCron) validateCron(input.cron)
  else if (input.timeZone !== undefined) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0006({ message: "`defineSchedule()` timeZone needs a cron. A Schedule without cron takes its time zone from `startSchedule()`." })
  }

  if (typeof input.handler !== "function") {
    throw scheduleErrorDiagnostics.SCHEDULE_C0005({ message: "`defineSchedule()` requires a schedule handler." })
  }

  if (input.manual !== undefined && input.manual !== true && input.manual !== false) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0006({ message: "`defineSchedule()` manual must be a boolean." })
  }

  if (input.timeZone !== undefined && !isIanaTimeZone(input.timeZone)) {
    throw scheduleErrorDiagnostics.SCHEDULE_C0006({ message: "`defineSchedule()` timeZone must be an IANA time zone, such as \"Europe/Madrid\"." })
  }

  const definition: ScheduleDefinition<TResult> = hasCron
    ? { cron: input.cron, handler: input.handler }
    : { handler: input.handler }
  if (input.timeZone !== undefined) {
    definition.timeZone = input.timeZone
  }
  if (input.manual !== undefined) {
    definition.options = { manual: input.manual }
  }
  return definition
}
