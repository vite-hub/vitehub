import { parseCronExpression } from "cron-schedule"

import type { RuntimeScheduleRecord } from "../types.ts"
import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

const weekdayIndexes = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6],
])
const minuteMs = 60_000
const hourMinutes = 60
const dayMinutes = 24 * hourMinutes
const nextRunHorizonMs = 4 * 366 * dayMinutes * minuteMs
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
  year: number
}

function timeZoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeZoneFormatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { day: "numeric", hour: "numeric", hourCycle: "h23", minute: "numeric", month: "numeric", timeZone, weekday: "short", year: "numeric" })
    timeZoneFormatters.set(timeZone, formatter)
  }
  return formatter
}

function scheduleDateFields(scheduledAt: Date, timeZone: string | undefined): ScheduleDateFields {
  if (!timeZone || timeZone === "UTC") return { day: scheduledAt.getUTCDate(), hour: scheduledAt.getUTCHours(), minute: scheduledAt.getUTCMinutes(), month: scheduledAt.getUTCMonth(), weekday: scheduledAt.getUTCDay(), year: scheduledAt.getUTCFullYear() }
  const values = new Map(timeZoneFormatter(timeZone).formatToParts(scheduledAt).map(part => [part.type, part.value]))
  const weekday = weekdayIndexes.get(values.get("weekday") || "")
  const day = Number(values.get("day")); const hour = Number(values.get("hour")); const minute = Number(values.get("minute")); const month = Number(values.get("month")) - 1; const year = Number(values.get("year"))
  if (weekday === undefined || [day, hour, minute, month, year].some(value => !Number.isInteger(value))) throw scheduleErrorDiagnostics.SCHEDULE_R0022({ message: `Schedule time zone could not resolve calendar fields: ${timeZone}` })
  return { day, hour, minute, month, weekday, year }
}

function parseScheduleCron(schedule: ScheduleCronRecord): ScheduleCron {
  if (schedule.cron.trim().split(/\s+/).length !== 5) throw scheduleErrorDiagnostics.SCHEDULE_R0023({ message: `Schedule "${schedule.id}" must use a five-field cron expression.` })
  return parseCronExpression(schedule.cron)
}

function matchesCronHour(cron: ScheduleCron, fields: ScheduleDateFields): boolean {
  if (!cron.hours.includes(fields.hour) || !cron.months.includes(fields.month)) return false
  if (cron.days.length !== 31 && cron.weekdays.length !== 7) return cron.days.includes(fields.day) || cron.weekdays.includes(fields.weekday)
  return cron.days.includes(fields.day) && cron.weekdays.includes(fields.weekday)
}

function localEpochMs(fields: ScheduleDateFields): number {
  const date = new Date(0)
  date.setUTCFullYear(fields.year, fields.month, fields.day)
  date.setUTCHours(fields.hour, fields.minute, 0, 0)
  return date.getTime()
}

function sameLocalMinute(left: ScheduleDateFields, right: ScheduleDateFields): boolean {
  return left.minute === right.minute && left.hour === right.hour && left.day === right.day && left.month === right.month && left.year === right.year
}

/** Detect a repeated local minute using the actual offset before the transition (including historical 23-hour rollbacks). */
function isRepeatedFixedLocalTime(cron: ScheduleCron, fields: ScheduleDateFields, scheduledAt: Date, timeZone: string | undefined): boolean {
  if (!timeZone || timeZone === "UTC" || cron.minutes.length === hourMinutes || cron.hours.length === 24) return false
  const previous = new Date(scheduledAt.getTime() - dayMinutes * minuteMs)
  const currentOffset = localEpochMs(fields) - scheduledAt.getTime()
  const previousFields = scheduleDateFields(previous, timeZone)
  const previousOffset = localEpochMs(previousFields) - previous.getTime()
  if (previousOffset <= currentOffset) return false
  const firstOccurrence = new Date(scheduledAt.getTime() - (previousOffset - currentOffset))
  return sameLocalMinute(scheduleDateFields(firstOccurrence, timeZone), fields)
}

export function isScheduleDue(schedule: ScheduleCronRecord, scheduledAt: Date): boolean {
  if (scheduledAt.getUTCSeconds() !== 0 || scheduledAt.getUTCMilliseconds() !== 0) return false
  const cron = parseScheduleCron(schedule)
  const fields = scheduleDateFields(scheduledAt, schedule.timeZone)
  return cron.minutes.includes(fields.minute) && matchesCronHour(cron, fields) && !isRepeatedFixedLocalTime(cron, fields, scheduledAt, schedule.timeZone)
}

export function isRuntimeScheduleDue(schedule: RuntimeScheduleRecord, scheduledAt: Date): boolean {
  return isScheduleDue(schedule, scheduledAt)
}

function safeAdvance(cursor: number, minutes: number, fields: ScheduleDateFields, timeZone: string | undefined): number {
  if (!timeZone || timeZone === "UTC" || minutes === 1) return cursor + minutes * minuteMs
  const advanced = scheduleDateFields(new Date(cursor + minutes * minuteMs), timeZone)
  const expected = (fields.hour * hourMinutes + fields.minute + minutes) % dayMinutes
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
        cursor += minuteMs
        continue
      }
    }
    cursor = safeAdvance(cursor, hourMinutes - fields.minute, fields, schedule.timeZone)
  }
  return undefined
}
