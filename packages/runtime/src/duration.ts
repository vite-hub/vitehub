import { runtimeErrorDiagnostics } from "./error-diagnostics.ts"

/** The units of a {@link Duration}, short and long. Case does not matter at runtime. */
export type DurationUnit =
  | "ms" | "millisecond" | "milliseconds"
  | "s" | "sec" | "secs" | "second" | "seconds"
  | "m" | "min" | "mins" | "minute" | "minutes"
  | "h" | "hr" | "hrs" | "hour" | "hours"
  | "d" | "day" | "days"
  | "w" | "week" | "weeks"

/** A length of time as a number and a unit, such as `"30s"`, `"5m"`, `"2 hours"`, or `"1 day"`. */
export type Duration = `${number}${DurationUnit}` | `${number} ${DurationUnit}`

const second = 1_000
const minute = 60 * second
const hour = 60 * minute
const day = 24 * hour
const week = 7 * day

const units: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: second,
  sec: second,
  secs: second,
  second,
  seconds: second,
  m: minute,
  min: minute,
  mins: minute,
  minute,
  minutes: minute,
  h: hour,
  hr: hour,
  hrs: hour,
  hour,
  hours: hour,
  d: day,
  day,
  days: day,
  w: week,
  week,
  weeks: week,
}

const pattern = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i

/** The shortest whole string form of `milliseconds`, such as `"5m"` for `300000`. */
function suggest(milliseconds: number): string {
  for (const [unit, size] of [["w", week], ["d", day], ["h", hour], ["m", minute], ["s", second]] as const) {
    if (milliseconds >= size && milliseconds % size === 0) return `"${milliseconds / size}${unit}"`
  }
  return `"${milliseconds}ms"`
}

/** Names a value for an error without converting an object, which could run its code. */
function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "object" && value !== null) return "an object"
  return typeof value === "function" || typeof value === "symbol" ? `a ${typeof value}` : String(value)
}

/**
 * Reads a {@link Duration} such as `"30s"`, `"5m"`, or `"1 day"` and returns its milliseconds. A number, a negative
 * value, an unknown unit, or a value too large for a number throws `RUNTIME_DURATION_INVALID`. Pass `option`, such as
 * `"debounce"`, so the error names the option.
 *
 * ```ts
 * parseDuration("90s") // 90000
 * parseDuration("1 day") // 86400000
 * ```
 */
export function parseDuration(value: Duration, option?: string): number {
  const [, amount, unit] = (typeof value === "string" ? pattern.exec(value.trim()) : null) ?? []
  const size = unit === undefined ? undefined : units[unit.toLowerCase()]
  const milliseconds = size === undefined ? Number.NaN : Number(amount) * size
  if (Number.isFinite(milliseconds)) return milliseconds
  const received: unknown = value
  const suggestion = typeof received === "number" && Number.isFinite(received) && received >= 0 ? suggest(received) : undefined
  throw runtimeErrorDiagnostics.RUNTIME_DURATION_INVALID({ option, value: describe(received), suggestion })
}
