import type { AgentInvocationRecord } from "../invocations.ts"
import type { TraceEventLogEntry } from "@vite-hub/runtime"

const searchableObservationContent = new Set([
  "channel.effect.content",
  "input.messages",
  "input.prompt",
  "message.content",
  "result.text",
  "vitehub.activity.progress",
])

const excludedObservationContent = new Set([
  "tool.input",
  "tool.output",
  "vitehub.activity.body",
])

type SearchValue = boolean | number | string
type SearchValues = {
  characters: number
  maximumCharacters: number
  values: Set<SearchValue>
}

const maximumSearchStringCharacters = 16 * 1024
const maximumSummarySearchCharacters = 32 * 1024
const maximumObservationSearchCharacters = 128 * 1024

function appendSearchValue(value: SearchValue, output: SearchValues): void {
  if (output.values.has(value) || output.characters >= output.maximumCharacters) return
  if (typeof value !== "string") {
    output.values.add(value)
    output.characters += String(value).length
    return
  }
  const remaining = output.maximumCharacters - output.characters
  const searchable = value.slice(0, Math.min(maximumSearchStringCharacters, remaining))
  if (!searchable || output.values.has(searchable)) return
  output.values.add(searchable)
  output.characters += searchable.length
}

function appendContentStrings(
  value: unknown,
  output: SearchValues,
  includeKeys: boolean,
  seen = new Set<object>(),
): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    appendSearchValue(value, output)
    return
  }
  if (!value || typeof value !== "object" || seen.has(value) || output.characters >= output.maximumCharacters) return
  seen.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (includeKeys && !Array.isArray(value)) appendSearchValue(key, output)
    appendContentStrings(child, output, includeKeys, seen)
  }
}

function appendSearchableObservation(observation: TraceEventLogEntry, output: SearchValues): void {
  appendSearchValue(observation.name, output)
  appendSearchValue(observation.timestamp, output)
  appendSearchValue(observation.type, output)
  for (const [key, value] of Object.entries(observation.attributes ?? {})) {
    if (excludedObservationContent.has(key)) continue
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      appendSearchValue(key, output)
      appendSearchValue(value, output)
      continue
    }
    if (searchableObservationContent.has(key) || key.startsWith("error.")) {
      appendSearchValue(key, output)
      appendContentStrings(value, output, true)
    }
  }
}

function searchableSummary(
  record: AgentInvocationRecord | Omit<AgentInvocationRecord, "cursor">,
): Omit<AgentInvocationRecord, "cursor" | "observations"> {
  if ("cursor" in record) {
    const { cursor: _cursor, observations: _observations, ...summary } = record
    return summary
  }
  const { observations: _observations, ...summary } = record
  return summary
}

export function searchableAgentInvocationText(
  record: AgentInvocationRecord | Omit<AgentInvocationRecord, "cursor">,
): string {
  const summaryValues: SearchValues = {
    characters: 0,
    maximumCharacters: maximumSummarySearchCharacters,
    values: new Set(),
  }
  const observationValues: SearchValues = {
    characters: 0,
    maximumCharacters: maximumObservationSearchCharacters,
    values: new Set(),
  }
  appendContentStrings(searchableSummary(record), summaryValues, true)
  for (const observation of record.observations) appendSearchableObservation(observation, observationValues)
  return JSON.stringify([[...summaryValues.values], [...observationValues.values]]).toLowerCase()
}
