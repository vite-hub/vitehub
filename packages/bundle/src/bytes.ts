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
