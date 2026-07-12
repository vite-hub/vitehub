import { parseCronExpression } from "cron-schedule"

import type { RuntimeScheduleRecord } from "../types.ts"

const weekdayIndexes = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
])

function scheduleDateFields(scheduledAt: Date, timeZone: string | undefined) {
  if (!timeZone) {
    return {
      day: scheduledAt.getUTCDate(),
      hour: scheduledAt.getUTCHours(),
      minute: scheduledAt.getUTCMinutes(),
      month: scheduledAt.getUTCMonth(),
      weekday: scheduledAt.getUTCDay(),
    }
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
    month: "numeric",
    timeZone,
    weekday: "short",
  }).formatToParts(scheduledAt)
  const values = new Map(parts.map(part => [part.type, part.value]))
  const weekday = weekdayIndexes.get(values.get("weekday") || "")
  const day = Number(values.get("day"))
  const hour = Number(values.get("hour"))
  const minute = Number(values.get("minute"))
  const month = Number(values.get("month")) - 1
  if (weekday === undefined || [day, hour, minute, month].some(value => !Number.isInteger(value))) {
    throw new TypeError(`Runtime Schedule time zone could not resolve calendar fields: ${timeZone}`)
  }
  return { day, hour, minute, month, weekday }
}

export function isRuntimeScheduleDue(schedule: RuntimeScheduleRecord, scheduledAt: Date): boolean {
  if (schedule.cron.trim().split(/\s+/).length !== 5) {
    throw new TypeError(`Runtime Schedule "${schedule.id}" must use a five-field cron expression.`)
  }
  const cron = parseCronExpression(schedule.cron)
  const { day, hour, minute, month, weekday } = scheduleDateFields(scheduledAt, schedule.timeZone)

  if (!cron.minutes.includes(minute) || !cron.hours.includes(hour) || !cron.months.includes(month)) {
    return false
  }
  if (cron.days.length !== 31 && cron.weekdays.length !== 7) {
    return cron.days.includes(day) || cron.weekdays.includes(weekday)
  }
  return cron.days.includes(day) && cron.weekdays.includes(weekday)
}
