const MB = 1000 * 1000
export const memoryBudget = 0.5 * MB
export const memoryNoiseLimit = 3 * MB

const mean = values => values.reduce((total, value) => total + value, 0) / values.length

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function memoryVerdict({ offA, on, offB }) {
  const differences = on.map((value, index) => value - (offA[index] + offB[index]) / 2)
  const change = median(differences)
  const noise = mean(offB.map((value, index) => Math.abs(value - offA[index])))
  const lower = median(on.map((value, index) => value - Math.max(offA[index], offB[index])))
  const upper = median(on.map((value, index) => value - Math.min(offA[index], offB[index])))
  let result = "INCONCLUSIVE"
  if (2 * noise <= memoryNoiseLimit) {
    if (lower > memoryBudget || upper < -memoryBudget) result = "FAIL"
    else if (lower >= -memoryBudget && upper <= memoryBudget) result = "PASS"
  }
  return { change, noise, lower, upper, result, differences }
}
