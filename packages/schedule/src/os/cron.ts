import { parseCronExpression } from "cron-schedule"

/**
 * The values of a five-field cron, sorted. `months` are 1 to 12 and `weekdays` 0 to 6 with Sunday 0.
 * A field is restricted when it does not hold every value. When both day fields are restricted, the cron runs on a
 * day that matches either of them; when one is restricted, only that one counts. The ViteHub runtime does the same.
 */
export interface CronFields {
  minutes: number[]
  hours: number[]
  days: number[]
  months: number[]
  weekdays: number[]
}

const allMonths = range(1, 12)
const allWeekdays = range(0, 6)

export function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index)
}

/** Reads a five-field cron. Returns `undefined` for anything else. */
export function parseCronFields(cron: string): CronFields | undefined {
  if (cron.trim() !== cron || cron.split(/\s+/).length !== 5) return undefined
  try {
    const parsed = parseCronExpression(cron)
    const sorted = (values: readonly number[]) => [...new Set(values)].sort((left, right) => left - right)
    return {
      minutes: sorted(parsed.minutes),
      hours: sorted(parsed.hours),
      days: sorted(parsed.days),
      months: sorted(parsed.months.map(month => month + 1)),
      weekdays: sorted(parsed.weekdays.map(weekday => weekday % 7)),
    }
  }
  catch {
    return undefined
  }
}

export function isDayRestricted(fields: CronFields): boolean {
  return fields.days.length !== 31
}

export function isWeekdayRestricted(fields: CronFields): boolean {
  return fields.weekdays.length !== allWeekdays.length
}

export function isMonthRestricted(fields: CronFields): boolean {
  return fields.months.length !== allMonths.length
}

/** True when every day field holds every value, so the cron runs on every day. */
export function runsEveryDay(fields: CronFields): boolean {
  return !isDayRestricted(fields) && !isWeekdayRestricted(fields) && !isMonthRestricted(fields)
}

/** Minutes of the day when the cron runs, sorted. */
export function timesOfDay(fields: CronFields): number[] {
  return fields.hours.flatMap(hour => fields.minutes.map(minute => hour * 60 + minute))
}

/** The step of a sorted list of two or more values with equal gaps, else `undefined`. One value has step 0. */
export function arithmeticStep(values: readonly number[]): number | undefined {
  if (values.length < 2) return 0
  const step = values[1]! - values[0]!
  return values.every((value, index) => index === 0 || value - values[index - 1]! === step) ? step : undefined
}
