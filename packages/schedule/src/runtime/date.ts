import { invalidScheduleValueDetails, createScheduleError } from "../errors.ts"

export function isScheduleDate(value: unknown): value is Date {
  try {
    if (Object.prototype.toString.call(value) !== "[object Date]") return false
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
