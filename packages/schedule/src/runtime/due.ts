import { parseCronExpression } from "cron-schedule"

import type { RuntimeScheduleRecord } from "../types.ts"

export function floorUTCMinute(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
  ))
}

export function isRuntimeScheduleDue(schedule: RuntimeScheduleRecord, scheduledAt: Date): boolean {
  if (schedule.cron.trim().split(/\s+/).length !== 5) {
    throw new TypeError(`Runtime Schedule "${schedule.id}" must use a five-field cron expression.`)
  }
  const cron = parseCronExpression(schedule.cron)
  const minute = scheduledAt.getUTCMinutes()
  const hour = scheduledAt.getUTCHours()
  const day = scheduledAt.getUTCDate()
  const month = scheduledAt.getUTCMonth()
  const weekday = scheduledAt.getUTCDay()

  if (!cron.minutes.includes(minute) || !cron.hours.includes(hour) || !cron.months.includes(month)) {
    return false
  }
  if (cron.days.length !== 31 && cron.weekdays.length !== 7) {
    return cron.days.includes(day) || cron.weekdays.includes(weekday)
  }
  return cron.days.includes(day) && cron.weekdays.includes(weekday)
}
