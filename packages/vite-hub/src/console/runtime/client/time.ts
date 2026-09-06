export function relativeDuration(elapsed: number): string {
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s`
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  return `${Math.floor(elapsed / 3_600_000)}h`
}
