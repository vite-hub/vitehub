export function relativeDuration(elapsed: number): string {
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  return `${Math.floor(elapsed / 3_600_000)}h`
}

/**
 * Returns a short label for a recent timestamp: `now`, `5m ago`, or `3h ago` within one day, else a UTC date such as `Aug 30`.
 * Returns undefined for an invalid timestamp.
 */
export function recentTimestamp(value: string, now: number): string | undefined {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return undefined
  const elapsed = Math.max(0, now - time)
  if (elapsed < 60_000) return "now"
  if (elapsed < 86_400_000) return `${relativeDuration(elapsed)} ago`
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", timeZone: "UTC" }).format(time)
}
