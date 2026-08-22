export const STALE_AFTER_MS = 30_000

export function relativeDuration(elapsedMs: number): string {
  if (elapsedMs < 60_000) return `${Math.floor(elapsedMs / 1_000)}s`
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m`
  return `${Math.floor(elapsedMs / 3_600_000)}h`
}

export function syncFreshness(lastSuccessfulPollAt: number | undefined, nowMs: number): { label: string, stale: boolean } {
  if (lastSuccessfulPollAt === undefined) return { label: 'Connecting', stale: false }
  const elapsed = Math.max(0, nowMs - lastSuccessfulPollAt)
  return elapsed >= STALE_AFTER_MS
    ? { label: `Stale · ${relativeDuration(elapsed)}`, stale: true }
    : { label: 'Updated now', stale: false }
}
