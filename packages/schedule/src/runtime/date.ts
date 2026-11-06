import { invalidScheduleValueDetails, createScheduleError } from "../errors.ts"

export function isScheduleDate(value: unknown): value is Date {
  try {
    // `getTime` checks the internal Date slot in every realm. Do not read
    // `Symbol.toStringTag`, because callers can define or throw from it.
    return !Number.isNaN(Date.prototype.getTime.call(value as Date))
  }
  catch {
    return false
  }
}

// A date-time with a time zone, so the time does not depend on the server. JavaScript accepts `T24:00` and rolls
// `02-30` into March, so `parseScheduledAt()` also checks the hour and the day of the month.
const scheduledAtText = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i

function parseScheduledAtText(value: string): Date | undefined {
  const match = scheduledAtText.exec(value)
  if (!match) return
  const [, year, month, day, hour] = match.map(Number)
  const calendarDay = new Date(0)
  calendarDay.setUTCFullYear(year!, month! - 1, day!)
  if (hour! > 23 || calendarDay.getUTCMonth() !== month! - 1 || calendarDay.getUTCDate() !== day!) return
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export function validateScheduledAt(scheduledAt: Date | undefined): Date {
  const value = scheduledAt ?? new Date()
  if (!isScheduleDate(value)) {
    throw createScheduleError("SCHEDULE_INVALID_SCHEDULED_AT", {
      details: invalidScheduleValueDetails("scheduledAt", value),
    })
  }
  return new Date(Date.prototype.getTime.call(value))
}

/**
 * Returns the time a manual run treats as its fire time. A string must be an ISO 8601 date-time with a time zone, such
 * as `2026-01-31T23:59:00Z`. Anything else fails with `SCHEDULE_INVALID_SCHEDULED_AT`. Absent means now.
 */
export function parseScheduledAt(scheduledAt: Date | string | undefined): Date {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The run time comes from CLI, RPC, or dispatch input.
  if (typeof scheduledAt !== "string") return validateScheduledAt(scheduledAt)
  const parsed = parseScheduledAtText(scheduledAt)
  if (parsed) return parsed
  throw createScheduleError("SCHEDULE_INVALID_SCHEDULED_AT", { details: invalidScheduleValueDetails("scheduledAt", scheduledAt) })
}
