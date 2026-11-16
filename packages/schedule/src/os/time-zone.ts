import { timeZoneOffsetMinutes } from "../runtime/due.ts"
import { isDayRestricted, isMonthRestricted, runsEveryDay, timesOfDay } from "./cron.ts"
import { osScheduleErrors } from "./errors.ts"

import type { Result } from "@vite-hub/runtime"
import type { CronFields } from "./cron.ts"
import type { OsScheduleErrorCode } from "./errors.ts"
import type { OsHost, OsTimerSpec } from "./host.ts"

const minuteMs = 60_000
const dayMs = 24 * 60 * minuteMs
const dayMinutes = 24 * 60
// Two years cover every offset of a time zone's current rules.
const sampledDays = 2 * 366

function modulo(value: number, size: number): number {
  return ((value % size) + size) % size
}

/** The minutes, from `from` to `to`, where the offset of `timeZone` changes. It assumes at most one change a day. */
function offsetChanges(timeZone: string, from: number, to: number): number[] {
  const offset = (time: number) => timeZoneOffsetMinutes(new Date(time), timeZone)
  const changes: number[] = []
  let previous = from
  let previousOffset = offset(from)
  while (previous < to) {
    const time = Math.min(previous + dayMs, to)
    const current = offset(time)
    if (current !== previousOffset) {
      let low = previous
      let high = time
      while (high - low > minuteMs) {
        const middle = low + Math.floor((high - low) / minuteMs / 2) * minuteMs
        if (offset(middle) === previousOffset) low = middle
        else high = middle
      }
      changes.push(high)
    }
    previous = time
    previousOffset = current
  }
  return changes
}

/** Every value of `offset(timeZone) - offset(machineTimeZone)`, in minutes, in the two years from `from`. */
function offsetDifferences(timeZone: string, machineTimeZone: string, from: Date): number[] {
  const start = Math.floor(from.getTime() / minuteMs) * minuteMs
  const end = start + sampledDays * dayMs
  const instants = [start, ...offsetChanges(timeZone, start, end), ...offsetChanges(machineTimeZone, start, end)]
  const differences = new Set(instants.map(time => timeZoneOffsetMinutes(new Date(time), timeZone) - timeZoneOffsetMinutes(new Date(time), machineTimeZone)))
  return [...differences].sort((left, right) => left - right)
}

/** Hours and minutes whose product is exactly `times` (minutes of the day), else `undefined`. */
function asProduct(times: readonly number[]): Pick<CronFields, "hours" | "minutes"> | undefined {
  const unique = new Set(times)
  const hours = [...new Set([...unique].map(time => Math.floor(time / 60)))].sort((left, right) => left - right)
  const minutes = [...new Set([...unique].map(time => time % 60))].sort((left, right) => left - right)
  return hours.length * minutes.length === unique.size ? { hours, minutes } : undefined
}

/** The cron moved by a constant `difference`: the machine time is the Schedule time minus `difference` minutes. */
function shiftFields(fields: CronFields, difference: number): CronFields | undefined {
  const shifted = timesOfDay(fields).map(time => time - difference)
  const product = asProduct(shifted.map(time => modulo(time, dayMinutes)))
  if (!product) return undefined
  const dayShift = Math.floor(shifted[0]! / dayMinutes)
  if (shifted.every(time => Math.floor(time / dayMinutes) === dayShift)) {
    if (dayShift === 0) return { ...fields, ...product }
    // A weekday list moves with the day. A day of the month or a month cannot, because months have different lengths.
    if (isDayRestricted(fields) || isMonthRestricted(fields)) return undefined
    const weekdays = [...new Set(fields.weekdays.map(weekday => modulo(weekday + dayShift, 7)))].sort((left, right) => left - right)
    return { ...fields, ...product, weekdays }
  }
  return runsEveryDay(fields) ? { ...fields, ...product } : undefined
}

/**
 * The cron in the machine time zone, for launchd and Task Scheduler, which run timers in the machine's local time.
 * Returns `undefined` when no cron in the machine zone gives the same runs as `fields` in `timeZone`.
 */
export function machineCronFields(fields: CronFields, timeZone: string, machineTimeZone: string, from: Date): CronFields | undefined {
  if (timeZone === machineTimeZone) return fields
  const differences = offsetDifferences(timeZone, machineTimeZone, from)
  if (differences.length === 1) return differences[0] === 0 ? fields : shiftFields(fields, differences[0]!)
  // The difference changes with daylight saving time. Only a cron that gives the same times of day under every
  // difference, on every day, keeps its runs.
  if (!runsEveryDay(fields)) return undefined
  const key = (difference: number) => [...new Set(timesOfDay(fields).map(time => modulo(time - difference, dayMinutes)))].sort((left, right) => left - right).join(",")
  const first = key(differences[0]!)
  if (differences.some(difference => key(difference) !== first)) return undefined
  return shiftFields(fields, differences[0]!)
}

/** The cron in the machine time zone of `host`, or the error that says why the OS cannot run it there. */
export function machineFieldsOrError(platform: "darwin" | "win32", spec: OsTimerSpec, host: OsHost): Result<CronFields, OsScheduleErrorCode> {
  const fields = machineCronFields(spec.fields, spec.timeZone, host.machineTimeZone, host.now())
  return fields ? [undefined, fields] : [osScheduleErrors.SCHEDULE_OS_TIME_ZONE_UNSUPPORTED({ platform, timeZone: spec.timeZone, machineTimeZone: host.machineTimeZone }), undefined]
}
