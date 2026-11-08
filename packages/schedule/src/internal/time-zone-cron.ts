import { parseCronExpression } from "cron-schedule"

import { timeZoneOffsetMinutes } from "../runtime/due.ts"

const dayMs = 24 * 60 * 60_000
const dayMinutes = 24 * 60
// Two years cover every offset of a time zone's current rules. Each daylight saving period lasts longer than one day.
const sampledDays = 2 * 366
const utcCronCache = new Map<string, string | undefined>()

/** Offsets, in minutes east of UTC, that `timeZone` uses in the two years from `from`. */
export function timeZoneOffsets(timeZone: string, from: Date): number[] {
  const offsets = new Set<number>()
  for (let day = 0; day <= sampledDays; day++) offsets.add(timeZoneOffsetMinutes(new Date(from.getTime() + day * dayMs), timeZone))
  return [...offsets].sort((left, right) => left - right)
}

function sameValues(left: ReadonlySet<number>, right: readonly number[]): boolean {
  return left.size === right.length && right.every(value => left.has(value))
}

function renderField(values: ReadonlySet<number>, size: number, declared: { field: string, values: readonly number[] }): string {
  if (sameValues(values, declared.values)) return declared.field
  if (values.size === size) return "*"
  return [...values].sort((left, right) => left - right).join(",")
}

/**
 * Returns a UTC cron that fires at every minute where `cron` can be due in `timeZone`, or `undefined` when the time
 * zone is always UTC. Cloudflare, Vercel, Netlify, and Deno read cron in UTC only, so the host runs this cron and the
 * Schedule runtime checks the local time on each wake. The cron covers each offset of the next two years, so the
 * skipped hour of a spring-forward day and both copies of a repeated hour wake the Schedule.
 */
export function utcCronForTimeZone(cron: string, timeZone: string, from: Date = new Date()): string | undefined {
  const key = `${cron}\n${timeZone}\n${from.toISOString().slice(0, 10)}`
  if (utcCronCache.has(key)) return utcCronCache.get(key)
  const offsets = timeZoneOffsets(timeZone, from)
  const utcCron = offsets.length === 1 && offsets[0] === 0 ? undefined : expandCron(cron, offsets)
  utcCronCache.set(key, utcCron)
  return utcCron
}

function expandCron(cron: string, offsets: readonly number[]): string {
  const parsed = parseCronExpression(cron)
  const [minuteField, hourField, dayField, monthField, weekdayField] = cron.trim().split(/\s+/) as [string, string, string, string, string]
  const minutes = new Set<number>()
  const hours = new Set<number>()
  const dayShifts = new Set<number>()
  for (const offset of offsets) {
    for (const hour of parsed.hours) {
      for (const minute of parsed.minutes) {
        const utcMinute = hour * 60 + minute - offset
        const minuteOfDay = ((utcMinute % dayMinutes) + dayMinutes) % dayMinutes
        dayShifts.add(Math.floor(utcMinute / dayMinutes))
        hours.add(Math.floor(minuteOfDay / 60))
        minutes.add(minuteOfDay % 60)
      }
    }
  }
  const time = `${renderField(minutes, 60, { field: minuteField, values: parsed.minutes })} ${renderField(hours, 24, { field: hourField, values: parsed.hours })}`
  const [dayShift] = dayShifts
  if (dayShifts.size === 1 && dayShift === 0) return `${time} ${dayField} ${monthField} ${weekdayField}`
  // Shift a weekday list when every local time moves to the same UTC day. Otherwise wake every day, and let the runtime
  // check the local date.
  if (dayShifts.size === 1 && dayField === "*" && monthField === "*" && weekdayField !== "*") {
    const weekdays = new Set(parsed.weekdays.map(weekday => (weekday + dayShift! + 7) % 7))
    return `${time} * * ${renderField(weekdays, 7, { field: weekdayField, values: [] })}`
  }
  return `${time} * * *`
}
