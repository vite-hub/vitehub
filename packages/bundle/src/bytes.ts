/** Splits file bytes proportionally, carrying rounding between shares so their sum stays exact. */
export function allocateBytes(weights: readonly number[], bytes: number): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let weightSoFar = 0
  let allocated = 0
  return weights.map((weight) => {
    weightSoFar += weight
    const next = total === 0 ? 0 : Math.round(weightSoFar * bytes / total)
    const share = next - allocated
    allocated = next
    return share
  })
}

/** `1234567` becomes `1.23 MB`, like Vite's build output. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} kB`
  return `${bytes} B`
}
