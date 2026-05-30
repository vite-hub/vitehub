function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)

  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    let diagonal = previous[0]!
    previous[0] = leftIndex + 1

    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      const nextDiagonal = previous[rightIndex + 1]!
      previous[rightIndex + 1] = left[leftIndex] === right[rightIndex]
        ? diagonal
        : Math.min(diagonal, previous[rightIndex]!, previous[rightIndex + 1]!) + 1
      diagonal = nextDiagonal
    }
  }

  return previous[right.length]!
}

export function formatUnknownAgentMessage(name: string, available: string[], options: { prefix?: boolean } = {}): string {
  const details: string[] = []
  const suggestion = available
    .map(candidate => ({ candidate, distance: editDistance(name, candidate) }))
    .sort((left, right) => left.distance - right.distance)[0]

  if (suggestion && suggestion.distance <= Math.max(2, Math.floor(name.length / 3))) {
    details.push(`Did you mean "${suggestion.candidate}"?`)
  }
  if (available.length) {
    details.push(`Discovered agents: ${available.slice(0, 10).join(", ")}${available.length > 10 ? ", ..." : ""}.`)
  }
  if (options.prefix) {
    details.push("Make sure @vite-hub/agent is configured and the agent is discovered.")
  }

  return `${options.prefix ? "[vitehub] " : ""}Unknown agent: ${name}.${details.length ? ` ${details.join(" ")}` : ""}`
}
