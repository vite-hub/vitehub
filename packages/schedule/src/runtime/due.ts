import { parseCronExpression } from "cron-schedule"

import { scheduleErrorDiagnostics } from "../error-diagnostics.ts"

const weekdayIndexes = new Map([
  ["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6],
])
const minuteMs = 60_000
const hourMinutes = 60
const dayMinutes = 24 * hourMinutes
const timeZoneFormatters = new Map<string, Intl.DateTimeFormat>()

type ScheduleCron = ReturnType<typeof parseCronExpression>
const parsedScheduleCrons = new WeakMap<ScheduleCronRecord, { expression: string, cron: ScheduleCron }>()

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
  const expression = schedule.cron
  const cached = parsedScheduleCrons.get(schedule)
  if (cached?.expression === expression) return cached.cron
  if (expression.trim().split(/\s+/).length !== 5) throw scheduleErrorDiagnostics.SCHEDULE_R0023({ message: `Schedule "${schedule.id}" must use a five-field cron expression.` })
  const cron = parseCronExpression(expression)
  parsedScheduleCrons.set(schedule, { expression, cron })
  return cron
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

/**
 * Detect a local time that the clock skipped on a spring-forward day, read with the offset from before the gap, as
 * RFC 5545 and `Temporal` do. `02:30` in a gap from `02:00` to `03:00` maps to `03:30`, so it runs once that day.
 */
function matchesSkippedLocalTime(cron: ScheduleCron, fields: ScheduleDateFields, scheduledAt: Date, timeZone: string | undefined): boolean {
  if (!timeZone || timeZone === "UTC") return false
  const currentOffset = localEpochMs(fields) - scheduledAt.getTime()
  const previous = new Date(scheduledAt.getTime() - dayMinutes * minuteMs)
  const previousOffset = localEpochMs(scheduleDateFields(previous, timeZone)) - previous.getTime()
  if (previousOffset >= currentOffset) return false
  const beforeGap = new Date(scheduledAt.getTime() - (currentOffset - previousOffset))
  if (localEpochMs(scheduleDateFields(beforeGap, timeZone)) - beforeGap.getTime() !== previousOffset) return false
  const skipped = scheduleDateFields(new Date(scheduledAt.getTime() + previousOffset), undefined)
  return cron.minutes.includes(skipped.minute) && matchesCronHour(cron, skipped)
}

/** Returns `true` when `schedule` is due at the exact minute `scheduledAt`. */
export function isScheduleDue(schedule: ScheduleCronRecord, scheduledAt: Date): boolean {
  if (scheduledAt.getUTCSeconds() !== 0 || scheduledAt.getUTCMilliseconds() !== 0) return false
  const cron = parseScheduleCron(schedule)
  const fields = scheduleDateFields(scheduledAt, schedule.timeZone)
  if (cron.minutes.includes(fields.minute) && matchesCronHour(cron, fields)) return !isRepeatedFixedLocalTime(cron, fields, scheduledAt, schedule.timeZone)
  return matchesSkippedLocalTime(cron, fields, scheduledAt, schedule.timeZone)
}

/** Minutes east of UTC that `timeZone` uses at `at`, such as `120` for Madrid in summer. */
export function timeZoneOffsetMinutes(at: Date, timeZone: string): number {
  const minute = new Date(Math.floor(at.getTime() / minuteMs) * minuteMs)
  return Math.round((localEpochMs(scheduleDateFields(minute, timeZone)) - minute.getTime()) / minuteMs)
}

/**
 * Returns the newest minute at or before `at` that the UTC `cron` matches, within one day, or the current minute.
 * This is an estimate for hosts without a scheduled timestamp, not an identity for delayed or retried deliveries.
 */
export function latestCronMinute(cron: string, at: Date): Date {
  const record: ScheduleCronRecord = { cron, id: cron }
  const latest = Math.floor(at.getTime() / minuteMs) * minuteMs
  for (let time = latest; time > latest - dayMinutes * minuteMs; time -= minuteMs) {
    if (isScheduleDue(record, new Date(time))) return new Date(time)
  }
  return new Date(latest)
}
