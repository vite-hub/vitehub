import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorOptions } from "@vite-hub/runtime"

const scheduleErrorCodes = [
  "SCHEDULE_ALREADY_EXISTS",
  "SCHEDULE_DISABLED",
  "SCHEDULE_INVALID_CRON",
  "SCHEDULE_INVALID_ENABLED",
  "SCHEDULE_INVALID_ID",
  "SCHEDULE_INVALID_INPUT",
  "SCHEDULE_INVALID_SCHEDULED_AT",
  "SCHEDULE_INVALID_TARGET",
  "SCHEDULE_INVALID_TIME_ZONE",
  "SCHEDULE_NOT_DUE",
  "SCHEDULE_NOT_FOUND",
  "SCHEDULE_RUN_NOT_FOUND",
  "SCHEDULE_TARGET_NOT_ELIGIBLE",
  "SCHEDULE_TARGET_NOT_FOUND",
] as const

const scheduleErrorFields = ["cron", "enabled", "id", "input", "options", "scheduledAt", "target", "timeZone"] as const
const scheduleErrorValueTypes = ["array", "bigint", "boolean", "date", "function", "null", "number", "object", "string", "symbol", "undefined", "unknown"] as const

export type ScheduleErrorCode = typeof scheduleErrorCodes[number]
export type ScheduleErrorField = typeof scheduleErrorFields[number]
export type ScheduleErrorValueType = typeof scheduleErrorValueTypes[number]
export type ScheduleValidationErrorCode = Extract<ScheduleErrorCode, `SCHEDULE_INVALID_${string}`>
export type ScheduleErrorDetails = { field: ScheduleErrorField, valueType: ScheduleErrorValueType }
export type ScheduleErrorOptions = ViteHubErrorOptions<ScheduleErrorDetails>

const scheduleErrorMessages: Record<ScheduleErrorCode, string> = {
  SCHEDULE_ALREADY_EXISTS: "Runtime Schedule already exists.",
  SCHEDULE_DISABLED: "Runtime Schedule is disabled.",
  SCHEDULE_INVALID_CRON: "Runtime Schedule cron is invalid.",
  SCHEDULE_INVALID_ENABLED: "Runtime Schedule enabled value is invalid.",
  SCHEDULE_INVALID_ID: "Runtime Schedule id is invalid.",
  SCHEDULE_INVALID_INPUT: "Runtime Schedule input is invalid.",
  SCHEDULE_INVALID_SCHEDULED_AT: "Runtime Schedule scheduledAt value is invalid.",
  SCHEDULE_INVALID_TARGET: "Runtime Schedule target is invalid.",
  SCHEDULE_INVALID_TIME_ZONE: "Runtime Schedule time zone is invalid.",
  SCHEDULE_NOT_DUE: "Schedule is not due.",
  SCHEDULE_NOT_FOUND: "Runtime Schedule was not found.",
  SCHEDULE_RUN_NOT_FOUND: "Schedule Run was not found.",
  SCHEDULE_TARGET_NOT_ELIGIBLE: "Runtime Schedule target is not eligible.",
  SCHEDULE_TARGET_NOT_FOUND: "Runtime Schedule target was not found.",
}

export function invalidScheduleValueDetails(field: ScheduleErrorField, value: unknown): ScheduleErrorDetails {
  let valueType: ScheduleErrorValueType
  try {
    valueType = value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : value instanceof Date
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

export function assertRuntimeScheduleId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw createScheduleError("SCHEDULE_INVALID_ID", {
      details: invalidScheduleValueDetails("id", id),
    })
  }
}
