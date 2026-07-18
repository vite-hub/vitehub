import { ViteHubError } from "@vite-hub/runtime"

import type { ViteHubErrorDetails, ViteHubErrorOptions } from "@vite-hub/runtime"

export type ScheduleErrorCode =
  | "SCHEDULE_ALREADY_EXISTS"
  | "SCHEDULE_DISABLED"
  | "SCHEDULE_INVALID_CRON"
  | "SCHEDULE_INVALID_ENABLED"
  | "SCHEDULE_INVALID_ID"
  | "SCHEDULE_INVALID_INPUT"
  | "SCHEDULE_INVALID_SCHEDULED_AT"
  | "SCHEDULE_INVALID_TARGET"
  | "SCHEDULE_INVALID_TIME_ZONE"
  | "SCHEDULE_NOT_DUE"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_RUN_NOT_FOUND"
  | "SCHEDULE_TARGET_NOT_ELIGIBLE"
  | "SCHEDULE_TARGET_NOT_FOUND"

export interface ScheduleErrorOptions<TCode extends ScheduleErrorCode = ScheduleErrorCode> extends ViteHubErrorOptions {
  code: TCode
  httpStatus?: number
}

export type ScheduleErrorField =
  | "cron"
  | "enabled"
  | "id"
  | "input"
  | "options"
  | "scheduledAt"
  | "target"
  | "timeZone"

export function invalidScheduleValueDetails(field: ScheduleErrorField, value: unknown): ViteHubErrorDetails {
  const valueType = value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : value instanceof Date
        ? "date"
        : typeof value
  return { field, valueType }
}

export function assertRuntimeScheduleId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id.trim()) {
    throw new ScheduleError("Runtime Schedule id must be a non-empty string.", {
      code: "SCHEDULE_INVALID_ID",
      details: invalidScheduleValueDetails("id", id),
      httpStatus: 400,
    })
  }
}

export class ScheduleError<TCode extends ScheduleErrorCode = ScheduleErrorCode> extends ViteHubError<TCode> {
  readonly httpStatus?: number

  constructor(message: string, options: ScheduleErrorOptions<TCode>) {
    super(options.code, message, options)
    this.name = "ScheduleError"
    this.httpStatus = options.httpStatus
  }
}
