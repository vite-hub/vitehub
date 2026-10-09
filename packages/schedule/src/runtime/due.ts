import { parseCronExpression } from "cron-schedule"

import type { RuntimeScheduleRecord } from "../types.ts"
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

const minuteMs = 60_000
const hourMinutes = 60
/** Longest search window for the next run. It covers leap-day crons such as `0 0 29 2 *`. */
const nextRunHorizonMs = 4 * 366 * 24 * hourMinutes * minuteMs
const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>()

type ScheduleCron = ReturnType<typeof parseCronExpression>

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
    throw scheduleErrorDiagnostics.SCHEDULE_R0022({ message: `Runtime Schedule time zone could not resolve calendar fields: ${timeZone}` })
  }
  return { day, hour, minute, month, weekday }
}

function parseScheduleCron(schedule: RuntimeScheduleRecord): ScheduleCron {
  if (schedule.cron.trim().split(/\s+/).length !== 5) {
    throw scheduleErrorDiagnostics.SCHEDULE_R0023({ message: `Runtime Schedule "${schedule.id}" must use a five-field cron expression.` })
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

export function isRuntimeScheduleDue(schedule: RuntimeScheduleRecord, scheduledAt: Date): boolean {
  if (scheduledAt.getUTCSeconds() !== 0 || scheduledAt.getUTCMilliseconds() !== 0) {
    return false
  }
  const cron = parseScheduleCron(schedule)
  const fields = scheduleDateFields(scheduledAt, schedule.timeZone)
  return cron.minutes.includes(fields.minute) && matchesCronHour(cron, fields)
}

/**
 * Returns the first minute after `after` when `schedule` is due, or `undefined` when no minute in the next four
 * years matches. The result uses the same cron and time zone rules as {@link isRuntimeScheduleDue}. It does not
 * check `enabled`, and it does not mean that a wake driver will run the Schedule.
 */
function safeAdvance(cursor: number, minutes: number, fields: ScheduleDateFields, timeZone: string | undefined): number {
  if (!timeZone || timeZone === "UTC" || minutes === 1) return cursor + minutes * minuteMs
  const advanced = scheduleDateFields(new Date(cursor + minutes * minuteMs), timeZone)
  const expected = (fields.hour * hourMinutes + fields.minute + minutes) % (24 * hourMinutes)
  // A DST offset change makes the local-clock jump unsafe. Search UTC minutes through the transition.
  return advanced.hour * hourMinutes + advanced.minute === expected ? cursor + minutes * minuteMs : cursor + minuteMs
}

export function nextRuntimeScheduleRunAt(schedule: RuntimeScheduleRecord, after: Date): Date | undefined {
  const cron = parseScheduleCron(schedule)
  let cursor = Math.floor(after.getTime() / minuteMs) * minuteMs + minuteMs
  const end = cursor + nextRunHorizonMs
  while (cursor <= end) {
    const fields = scheduleDateFields(new Date(cursor), schedule.timeZone)
    if (matchesCronHour(cron, fields)) {
      const minute = cron.minutes.find(value => value >= fields.minute)
      if (minute !== undefined) {
        const candidate = new Date(safeAdvance(cursor, minute - fields.minute, fields, schedule.timeZone))
        if (isRuntimeScheduleDue(schedule, candidate)) return candidate
        // A time zone offset change can move the candidate out of this local hour. Check the next minute.
        cursor += minuteMs
        continue
      }
    }
    cursor = safeAdvance(cursor, hourMinutes - fields.minute, fields, schedule.timeZone)
  }
  return undefined
}
