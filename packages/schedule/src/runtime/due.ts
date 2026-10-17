import { parseCronExpression } from "cron-schedule"

import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

const weekdayIndexes = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
])

const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>()

type ScheduleCron = ReturnType<typeof parseCronExpression>

/** The cron fields of one Schedule that the process checks. `timeZone` defaults to UTC. */
export interface ScheduleCronRecord {
  cron: string
  id: string
  timeZone?: string
}

interface ScheduleDateFields {
  day: number
  hour: number
  minute: number
  month: number
  weekday: number
}

function timeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeZoneFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
      minute: "numeric",
      month: "numeric",
      timeZone,
      weekday: "short",
    })
    timeZoneFormatters.set(timeZone, formatter)
  }
  return formatter
}

function scheduleDateFields(scheduledAt: Date, timeZone: string | undefined): ScheduleDateFields {
  if (!timeZone) {
    return {
      day: scheduledAt.getUTCDate(),
      hour: scheduledAt.getUTCHours(),
      minute: scheduledAt.getUTCMinutes(),
      month: scheduledAt.getUTCMonth(),
      weekday: scheduledAt.getUTCDay(),
    }
  }

  const parts = timeZoneFormatter(timeZone).formatToParts(scheduledAt)
  const values = new Map(parts.map(part => [part.type, part.value]))
  const weekday = weekdayIndexes.get(values.get("weekday") || "")
  const day = Number(values.get("day"))
  const hour = Number(values.get("hour"))
  const minute = Number(values.get("minute"))
  const month = Number(values.get("month")) - 1
  if (weekday === undefined || [day, hour, minute, month].some(value => !Number.isInteger(value))) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0022({ message: `Schedule time zone could not resolve calendar fields: ${timeZone}` })
  }
  return { day, hour, minute, month, weekday }
}

function parseScheduleCron(schedule: ScheduleCronRecord): ScheduleCron {
  if (schedule.cron.trim().split(/\s+/).length !== 5) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0023({ message: `Schedule "${schedule.id}" must use a five-field cron expression.` })
  }
  return parseCronExpression(schedule.cron)
}

function matchesCronHour(cron: ScheduleCron, fields: ScheduleDateFields): boolean {
  if (!cron.hours.includes(fields.hour) || !cron.months.includes(fields.month)) {
    return false
  }
  if (cron.days.length !== 31 && cron.weekdays.length !== 7) {
    return cron.days.includes(fields.day) || cron.weekdays.includes(fields.weekday)
  }
  return cron.days.includes(fields.day) && cron.weekdays.includes(fields.weekday)
}

/** Returns `true` when `schedule` is due at the exact minute `scheduledAt`. */
export function isScheduleDue(schedule: ScheduleCronRecord, scheduledAt: Date): boolean {
  if (scheduledAt.getUTCSeconds() !== 0 || scheduledAt.getUTCMilliseconds() !== 0) {
    return false
  }
  const cron = parseScheduleCron(schedule)
  const fields = scheduleDateFields(scheduledAt, schedule.timeZone)
  return cron.minutes.includes(fields.minute) && matchesCronHour(cron, fields)
}
