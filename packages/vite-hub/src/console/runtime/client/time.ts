export function relativeDuration(elapsed: number): string {
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

/** The calendar day of a timestamp in `timeZone`, as `YYYY-MM-DD`. */
function dayKey(time: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" }).format(time)
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
  if (day === dayKey(now - 86_400_000, timeZone)) return "Yesterday"
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
