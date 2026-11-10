import type { TraceEventLogEntry } from "@vite-hub/runtime"

/** An observation that a running Invocation appended as its own row. `position` orders the rows and never repeats. */
export interface ObservationRow {
  observation: TraceEventLogEntry
  position: number
}

export function parsedObservation(value: unknown): TraceEventLogEntry | undefined {
  if (typeof value !== "string") return
  const parsed: unknown = JSON.parse(value)
  if (parsed === null || typeof parsed !== "object" || !("name" in parsed) || typeof parsed.name !== "string") return
  // SAFETY: Observation rows are written from records that applyAgentInvocationStoreUpdate() produced.
  return parsed as TraceEventLogEntry
}

/**
 * Returns the row changes when an update kept the record's observations and the order of existing rows.
 * Appends and evictions of appended observations qualify. Any other change returns undefined.
 */
export function observationRowChanges(
  inRecord: readonly TraceEventLogEntry[],
  rows: readonly ObservationRow[],
  observations: readonly TraceEventLogEntry[],
): { added: TraceEventLogEntry[], removed: number[] } | undefined {
  if (observations.length < inRecord.length || inRecord.some((observation, index) => observations[index] !== observation)) return
  const positions = new Map(rows.map(row => [row.observation, row.position]))
  const kept = new Set<number>()
  const added: TraceEventLogEntry[] = []
  let lastPosition = -1
  for (const observation of observations.slice(inRecord.length)) {
    const position = positions.get(observation)
    if (position === undefined) {
      added.push(observation)
      continue
    }
    if (added.length || position <= lastPosition) return
    lastPosition = position
    kept.add(position)
  }
  return { added, removed: rows.flatMap(row => kept.has(row.position) ? [] : [row.position]) }
}
