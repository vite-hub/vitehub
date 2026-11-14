// Display helpers that every Console section shares, so one value reads the same on every page.
//
// Dates, times, and numbers use English ("en"), whatever the browser language: the Console copy is English, and most
// Console values already used it. Times show in the viewer's own time zone unless a function says UTC.

/**
 * A size such as `512 B`, `11.5 KB`, or `64 MB`. Units are powers of 1024, as in Blob `maxSize` options. Values under
 * 10 keep one decimal.
 */
export function consoleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** A count such as `1,234`. */
export function consoleNumber(value: number): string {
  return new Intl.NumberFormat("en").format(value)
}

/**
 * A duration such as `<1ms`, `480ms`, `41.2s`, `2m 5s`, or `1h 20m`. Under a minute, seconds keep one decimal, so the
 * steps of a trace compare on one scale. With `wholeSeconds`, as for the length of a whole session, seconds round first
 * and carry, so 59.5 seconds reads `1m 0s`. Returns undefined for a negative or invalid duration.
 */
export function consoleDuration(ms: number, options: { wholeSeconds?: boolean } = {}): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1) return "<1ms"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = Math.round(ms / 1_000)
  if (options.wholeSeconds ? seconds < 60 : ms < 60_000) {
    return options.wholeSeconds ? `${seconds}s` : `${new Intl.NumberFormat("en", { maximumFractionDigits: 1 }).format(ms / 1_000)}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A length of time in words, for a sentence such as "The session ends after 1 hour 30 minutes". */
export function consoleDurationWords(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`
  if (!hours) return unit(rest, "minute")
  return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour")
}

/** Up to two initials of a name or an email for an avatar without an image, such as `AL` for Ada Lovelace. */
export function consoleInitials(name: string): string {
  const words = name.replace(/@.*$/, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0] ?? "?").slice(0, 2)).toUpperCase()
}

/** An ISO 8601 timestamp with a time, such as `2026-10-15T11:00:00.000Z`. Dates without a time stay text. */
const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})/g

/**
 * Part of a text value: plain text, code in backticks such as a CLI command, or a timestamp that the Console shows as a
 * relative time.
 */
export type ConsoleValuePart = { kind: "code" | "text" | "time", value: string }

function timeParts(value: string): ConsoleValuePart[] {
  const parts: ConsoleValuePart[] = []
  let index = 0
  for (const match of value.matchAll(timestampPattern)) {
    if (!Number.isFinite(Date.parse(match[0]))) continue
    if (match.index > index) parts.push({ kind: "text", value: value.slice(index, match.index) })
    parts.push({ kind: "time", value: match[0] })
    index = match.index + match[0].length
  }
  if (index < value.length) parts.push({ kind: "text", value: value.slice(index) })
  return parts
}

/**
 * Splits a value that owner packages send as text, such as a Schedule's `succeeded at 2026-10-15T11:00:00.000Z`, into
 * text, code, and timestamps. Text in backticks is code. Components show each timestamp as a relative time with the
 * exact time in a tooltip.
 */
export function consoleValueParts(value: string): ConsoleValuePart[] {
  return value.split(/(`[^`\n]+`)/).flatMap((chunk): ConsoleValuePart[] => {
    if (!chunk) return []
    if (chunk.length > 2 && chunk.startsWith("`") && chunk.endsWith("`")) return [{ kind: "code", value: chunk.slice(1, -1) }]
    return timeParts(chunk)
  })
}

export type ConsoleStatusTone = "error" | "neutral" | "success" | "warning"

export interface ConsoleStatusValue {
  label: string
  pending?: boolean
  tone: ConsoleStatusTone
}

const statusWords: Record<string, Omit<ConsoleStatusValue, "label">> = {
  active: { tone: "success" },
  cancelled: { tone: "neutral" },
  canceled: { tone: "neutral" },
  // Email deliveries. `Captured only` is a message that the development outbox kept without sending it.
  "captured only": { tone: "neutral" },
  completed: { tone: "success" },
  disabled: { tone: "neutral" },
  enabled: { tone: "success" },
  error: { tone: "error" },
  failed: { tone: "error" },
  open: { tone: "neutral" },
  pending: { pending: true, tone: "neutral" },
  queued: { pending: true, tone: "neutral" },
  resolved: { tone: "success" },
  running: { pending: true, tone: "neutral" },
  sending: { pending: true, tone: "neutral" },
  sent: { tone: "success" },
  skipped: { tone: "neutral" },
  succeeded: { tone: "success" },
  timeout: { tone: "error" },
  unavailable: { tone: "error" },
}

/**
 * Reads a whole value as a status, such as `Enabled` or `failed`, for a status dot with a sentence-case label. Other
 * values return undefined and stay text.
 */
export function consoleStatusValue(value: string): ConsoleStatusValue | undefined {
  const word = value.trim().toLowerCase()
  const status = statusWords[word]
  if (!status) return undefined
  return { ...status, label: `${word[0]!.toUpperCase()}${word.slice(1)}` }
}

function relativeDuration(elapsed: number): string {
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  return `${Math.floor(elapsed / 3_600_000)}h`
}

/**
 * Returns a short label for a recent timestamp: `now`, `5m ago`, or `3h ago` within one day, else a UTC date such as `Aug 30`.
 * With `seconds`, the first minute counts up as `3s ago` after five seconds of `now`, as a save status does.
 * Returns undefined for an invalid timestamp.
 */
export function recentTimestamp(value: string, now: number, options: { seconds?: boolean } = {}): string | undefined {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return undefined
  const elapsed = Math.max(0, now - time)
  if (options.seconds && elapsed >= 5_000 && elapsed < 60_000) return `${relativeDuration(elapsed)} ago`
  if (elapsed < 60_000) return "now"
  if (elapsed < 86_400_000) return `${relativeDuration(elapsed)} ago`
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(time)
}

/**
 * A recent timestamp in two lengths for a session row: `short` as `now`, `5m`, `3h`, or `Aug 30`, and `label` for a
 * tooltip or a screen reader, as `5 minutes ago` or a full UTC date. Returns undefined for an invalid or future time.
 */
export function consoleRelativeTime(value: string | undefined, now: number | undefined): { label: string, short: string } | undefined {
  if (!value || now === undefined) return undefined
  const elapsed = now - Date.parse(value)
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined
  if (elapsed < 60_000) return { label: "now", short: "now" }
  if (elapsed < 86_400_000) {
    const hours = elapsed >= 3_600_000
    const amount = Math.floor(elapsed / (hours ? 3_600_000 : 60_000))
    return { label: new Intl.RelativeTimeFormat("en").format(-amount, hours ? "hour" : "minute"), short: relativeDuration(elapsed) }
  }
  const date = Date.parse(value)
  return {
    label: new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date),
    short: new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(date),
  }
}

/** The calendar day of a timestamp in `timeZone`, as `YYYY-MM-DD`. */
function dayKey(time: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" }).formatToParts(time)
  const values = Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function previousDayKey(time: number, timeZone?: string): string {
  const [year, month, day] = dayKey(time, timeZone).split("-").map(Number)
  return dayKey(Date.UTC(year, month - 1, day - 1), "UTC")
}

/**
 * Names the day of a timestamp for a grouped feed: `Today`, `Yesterday`, then a date such as `Oct 12`, with the year
 * when it differs from the current one. Days follow `timeZone`, the viewer's own zone by default.
 */
export function dayLabel(value: string, now: number, timeZone?: string): string | undefined {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return undefined
  const day = dayKey(time, timeZone)
  if (day === dayKey(now, timeZone)) return "Today"
  if (day === previousDayKey(now, timeZone)) return "Yesterday"
  const sameYear = day.slice(0, 4) === dayKey(now, timeZone).slice(0, 4)
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone, ...(sameYear ? {} : { year: "numeric" }) }).format(time)
}

/** The exact time of a timestamp in UTC and in `timeZone`, for the tooltip of a relative time (Geist Relative Time Card). */
export function exactTimestamps(value: string, timeZone?: string): { local: string, utc: string } | undefined {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return undefined
  const format = (zone: string | undefined, name: "short" | undefined) => new Intl.DateTimeFormat("en", {
    day: "numeric",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "short",
    second: "2-digit",
    timeZone: zone,
    ...(name ? { timeZoneName: name } : {}),
    year: "numeric",
  }).format(time)
  return { local: format(timeZone, "short"), utc: `${format("UTC", undefined)} UTC` }
}

/**
 * A full date and time in the viewer's zone, such as `Oct 25, 2026, 11:30 AM`. The Console copy is English, so dates
 * use English too, whatever the browser language. Returns the input for an invalid timestamp.
 */
export function consoleDateTime(value: string | number): string {
  const time = typeof value === "number" ? value : Date.parse(value)
  return Number.isFinite(time) ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(time) : String(value)
}

/**
 * The clock time of a log event in `timeZone`, the viewer's own zone by default, such as `14:33:59.120`. Returns the
 * input for an invalid timestamp.
 */
export function consoleClockTime(value: string, timeZone?: string): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return new Intl.DateTimeFormat("en", {
    fractionalSecondDigits: 3,
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    second: "2-digit",
    timeZone,
  }).format(time)
}

/**
 * The time of day in the viewer's zone, such as `10:42 AM`, or `10:42:05 AM` with `seconds`, for "Editing since" or the
 * reset of a counter. Returns an empty string for a missing or invalid time.
 */
export function consoleTimeOfDay(value: string | number | null | undefined, options: { seconds?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return ""
  const time = typeof value === "number" ? value : Date.parse(value)
  if (!Number.isFinite(time)) return ""
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", ...(options.seconds ? { second: "2-digit" } : {}) }).format(time)
}

/** A date and a 24-hour time in the viewer's zone without the year, such as `Oct 20, 09:00`, for a schedule. */
export function consoleDayTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Intl.DateTimeFormat("en", { day: "numeric", hour: "2-digit", hourCycle: "h23", minute: "2-digit", month: "short" }).format(time) : value
}
