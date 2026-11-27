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
const sampledDays = 2 * 366

function modulo(value: number, size: number): number {
  return ((value % size) + size) % size
}

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

/** The wall-clock times of one local day that a clock change skips or repeats. */
export interface ClockChange {
  year: number
  /** 1 to 12. */
  month: number
  day: number
  /** 0 to 6, Sunday 0. */
  weekday: number
  /** First minute of the day that the change skips or repeats. */
  start: number
  /** Minute after the last one that the change skips or repeats. */
  end: number
  /** New offset minus old offset, in minutes: positive when the clocks go forward. */
  delta: number
}

/** The clock changes of `timeZone` in the two years from `from`, as windows of local days. */
export function clockChanges(timeZone: string, from: Date): ClockChange[] {
  const start = Math.floor(from.getTime() / minuteMs) * minuteMs
  const changes: ClockChange[] = []
  for (const instant of offsetChanges(timeZone, start, start + sampledDays * dayMs)) {
    const before = timeZoneOffsetMinutes(new Date(instant - minuteMs), timeZone)
    const after = timeZoneOffsetMinutes(new Date(instant), timeZone)
    const low = instant + Math.min(before, after) * minuteMs
    const high = instant + Math.max(before, after) * minuteMs
    for (let day = Math.floor(low / dayMs) * dayMs; day < high; day += dayMs) {
      const date = new Date(day)
      changes.push({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
        start: (Math.max(low, day) - day) / minuteMs,
        end: (Math.min(high, day + dayMs) - day) / minuteMs,
        delta: after - before,
      })
    }
  }
  return changes
}

function offsetDifferences(timeZone: string, machineTimeZone: string, from: Date): number[] {
  const start = Math.floor(from.getTime() / minuteMs) * minuteMs
  const end = start + sampledDays * dayMs
  const instants = [start, ...offsetChanges(timeZone, start, end), ...offsetChanges(machineTimeZone, start, end)]
  const differences = new Set(instants.map(time => timeZoneOffsetMinutes(new Date(time), timeZone) - timeZoneOffsetMinutes(new Date(time), machineTimeZone)))
  return [...differences].sort((left, right) => left - right)
}

function asProduct(times: readonly number[]): Pick<CronFields, "hours" | "minutes"> | undefined {
  const unique = new Set(times)
  const hours = [...new Set([...unique].map(time => Math.floor(time / 60)))].sort((left, right) => left - right)
  const minutes = [...new Set([...unique].map(time => time % 60))].sort((left, right) => left - right)
  return hours.length * minutes.length === unique.size ? { hours, minutes } : undefined
}

function shiftFields(fields: CronFields, difference: number): CronFields | undefined {
  const shifted = timesOfDay(fields).map(time => time - difference)
  const product = asProduct(shifted.map(time => modulo(time, dayMinutes)))
  if (!product) return undefined
  const dayShift = Math.floor(shifted[0]! / dayMinutes)
  if (shifted.every(time => Math.floor(time / dayMinutes) === dayShift)) {
    if (dayShift === 0) return { ...fields, ...product }
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
  if (!runsEveryDay(fields)) return undefined
  const key = (difference: number) => [...new Set(timesOfDay(fields).map(time => modulo(time - difference, dayMinutes)))].sort((left, right) => left - right).join(",")
  const first = key(differences[0]!)
  if (differences.some(difference => key(difference) !== first)) return undefined
  return shiftFields(fields, differences[0]!)
}

/** The cron in the machine time zone of `host`, or the error that says why the OS cannot run it there. */
export function machineFieldsOrError(platform: "darwin" | "win32", spec: OsTimerSpec, host: OsHost): Result<CronFields, OsScheduleErrorCode> {
  if (spec.timeZone === "local") return [undefined, spec.fields]
  const fields = machineCronFields(spec.fields, spec.timeZone, host.machineTimeZone, host.now())
  return fields ? [undefined, fields] : [osScheduleErrors.SCHEDULE_OS_TIME_ZONE_UNSUPPORTED({ platform, timeZone: spec.timeZone, machineTimeZone: host.machineTimeZone }), undefined]
}
