// Display helpers that every Console section shares, so one value reads the same on every page.

/**
 * A size such as `512 B`, `11.5 KB`, or `64 MB`. Units are powers of 1024, as in Blob `maxSize` options. Values under
 * 10 keep one decimal.
 */
export function consoleBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

/** An ISO 8601 timestamp with a time, such as `2026-10-15T11:00:00.000Z`. Dates without a time stay text. */
const timestampPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})/g

/**
 * Part of a text value: plain text, code in backticks such as a CLI command, or a timestamp that the Console shows as a
 * relative time.
 */
export type ConsoleValuePart = { kind: "code" | "text" | "time", value: string }

function timeParts(value: string): ConsoleValuePart[] {
  const parts: ConsoleValuePart[] = []
  let index = 0
  for (const match of value.matchAll(timestampPattern)) {
    if (!Number.isFinite(Date.parse(match[0]))) continue
    if (match.index > index) parts.push({ kind: "text", value: value.slice(index, match.index) })
    parts.push({ kind: "time", value: match[0] })
    index = match.index + match[0].length
  }
  if (index < value.length) parts.push({ kind: "text", value: value.slice(index) })
  return parts
}

/**
 * Splits a value that owner packages send as text, such as a Schedule's `succeeded at 2026-10-15T11:00:00.000Z`, into
 * text, code, and timestamps. Text in backticks is code. Components show each timestamp as a relative time with the
 * exact time in a tooltip.
 */
export function consoleValueParts(value: string): ConsoleValuePart[] {
  return value.split(/(`[^`\n]+`)/).flatMap((chunk): ConsoleValuePart[] => {
    if (!chunk) return []
    if (chunk.length > 2 && chunk.startsWith("`") && chunk.endsWith("`")) return [{ kind: "code", value: chunk.slice(1, -1) }]
    return timeParts(chunk)
  })
}

export type ConsoleStatusTone = "error" | "neutral" | "success" | "warning"

export interface ConsoleStatusValue {
  label: string
  pending?: boolean
  tone: ConsoleStatusTone
}

const statusWords: Record<string, Omit<ConsoleStatusValue, "label">> = {
  active: { tone: "success" },
  cancelled: { tone: "neutral" },
  canceled: { tone: "neutral" },
  completed: { tone: "success" },
  disabled: { tone: "neutral" },
  enabled: { tone: "success" },
  error: { tone: "error" },
  failed: { tone: "error" },
  pending: { pending: true, tone: "neutral" },
  queued: { pending: true, tone: "neutral" },
  running: { pending: true, tone: "neutral" },
  skipped: { tone: "neutral" },
  succeeded: { tone: "success" },
  timeout: { tone: "error" },
  unavailable: { tone: "error" },
}

/**
 * Reads a whole value as a status, such as `Enabled` or `failed`, for a status dot with a sentence-case label. Other
 * values return undefined and stay text.
 */
export function consoleStatusValue(value: string): ConsoleStatusValue | undefined {
  const word = value.trim().toLowerCase()
  const status = statusWords[word]
  if (!status) return undefined
  return { ...status, label: `${word[0]!.toUpperCase()}${word.slice(1)}` }
}
