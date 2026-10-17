import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorOptions } from "@vite-hub/runtime"

const scheduleErrorCodes = [
  "SCHEDULE_DEFINITION_NOT_FOUND",
  "SCHEDULE_INVALID_CRON",
  "SCHEDULE_INVALID_SCHEDULED_AT",
  "SCHEDULE_MANUAL_RUN_DISABLED",
  "SCHEDULE_NOT_DUE",
  "SCHEDULE_RUN_NOT_FOUND",
] as const

const scheduleErrorFields = ["cron", "scheduledAt"] as const
const scheduleErrorValueTypes = ["array", "bigint", "boolean", "date", "function", "null", "number", "object", "string", "symbol", "undefined", "unknown"] as const

export type ScheduleErrorCode = typeof scheduleErrorCodes[number]
export type ScheduleErrorField = typeof scheduleErrorFields[number]
export type ScheduleErrorValueType = typeof scheduleErrorValueTypes[number]
export type ScheduleValidationErrorCode = Extract<ScheduleErrorCode, `SCHEDULE_INVALID_${string}`>
export type ScheduleErrorDetails = { field: ScheduleErrorField, valueType: ScheduleErrorValueType }
export type ScheduleErrorOptions = ViteHubErrorOptions<ScheduleErrorDetails>

const scheduleErrorMessages: Record<ScheduleErrorCode, string> = {
  SCHEDULE_DEFINITION_NOT_FOUND: "Static Schedule Definition was not found.",
  SCHEDULE_INVALID_CRON: "Schedule cron is invalid.",
  SCHEDULE_INVALID_SCHEDULED_AT: "Schedule scheduledAt value is invalid.",
  SCHEDULE_MANUAL_RUN_DISABLED: "Schedule Definition does not allow manual runs. Set manual: true to allow them.",
  SCHEDULE_NOT_DUE: "Schedule is not due.",
  SCHEDULE_RUN_NOT_FOUND: "Schedule Run was not found.",
}

function isDateValue(value: unknown): value is Date {
  if (value instanceof Date) return true
  try {
    Date.prototype.getTime.call(value)
    return true
  }
  catch {
    return false
  }
}

export function invalidScheduleValueDetails(field: ScheduleErrorField, value: unknown): ScheduleErrorDetails {
  let valueType: ScheduleErrorValueType
  try {
    valueType = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : isDateValue(value)
          ? "date"
          : typeof value
  }
  catch {
    valueType = "unknown"
  }
  return { field, valueType }
}

export function createScheduleError<TCode extends ScheduleErrorCode>(
  code: TCode,
  options: ScheduleErrorOptions = {},
): ViteHubError<TCode, ScheduleErrorDetails> {
  return new ViteHubError(code, scheduleErrorMessages[code], options)
}
