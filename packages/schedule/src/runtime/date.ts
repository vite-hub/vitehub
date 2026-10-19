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

export function validateScheduledAt(scheduledAt: Date | undefined): Date {
  const value = scheduledAt ?? new Date()
  if (!isScheduleDate(value)) {
    throw createScheduleError("SCHEDULE_INVALID_SCHEDULED_AT", {
      details: invalidScheduleValueDetails("scheduledAt", value),
    })
  }
  return new Date(Date.prototype.getTime.call(value))
}
