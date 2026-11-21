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

function toMilliseconds(amount: string, size: number, round?: "ceil"): number {
  const [whole, fraction = ""] = amount.split(".")
  const scaled = BigInt(`${whole}${fraction}`) * BigInt(size)
  if (fraction.length === 0) return Number(scaled)
  if (round === "ceil") {
    const divisor = 10n ** BigInt(fraction.length)
    return Number((scaled + divisor - 1n) / divisor)
  }
  return Number(`${scaled}e-${fraction.length}`)
}

/**
 * Reads a {@link Duration} such as `"30s"`, `"5m"`, or `"1 day"` and returns its milliseconds. A number, a negative
 * value, an unknown unit, or a value too large for a number throws `RUNTIME_DURATION_INVALID`. Pass `option`, such as
 * `"debounce"`, so the error names the option. Pass `"ceil"` to round up to whole milliseconds before converting
 * to a number. For a number, the fix shows the same time as a string. Pass `"s"` as `legacyUnit` when the option took a
 * number of seconds before, so `60` gets the fix `"1m"` and not `"60ms"`. It changes only the fix text.
 *
 * ```ts
 * parseDuration("90s") // 90000
 * parseDuration("1 day") // 86400000
 * ```
 */
export function parseDuration(value: Duration, option?: string, round?: "ceil", legacyUnit: "ms" | "s" = "ms"): number {
  const [, amount, suffix] = (typeof value === "string" ? pattern.exec(value.trim()) : null) ?? []
  const unit = suffix?.toLowerCase()
  const size = unit !== undefined && Object.hasOwn(units, unit) ? units[unit] : undefined
  const milliseconds = amount === undefined || size === undefined ? Number.NaN : toMilliseconds(amount, size, round)
  if (Number.isFinite(milliseconds)) return milliseconds
  const received: unknown = value
  const legacy = typeof received === "number" && received >= 0 ? received * (legacyUnit === "s" ? second : 1) : Number.NaN
  const suggestion = Number.isFinite(legacy) ? suggest(legacy) : undefined
  const legacyUnitName = legacyUnit === "s" ? "seconds" : "milliseconds"
  throw runtimeErrorDiagnostics.RUNTIME_DURATION_INVALID({ option, value: describe(received), suggestion, unit: legacyUnitName })
}
