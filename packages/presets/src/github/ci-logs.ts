import * as v from "valibot"
import { presetsErrorDiagnostics } from "../error-diagnostics.ts"

/** The newest characters a compacted job log keeps. A checkout that lists every branch reaches 40 MB. */
const compactLimit = 4_000_000
const maxRangeLines = 1000

/** Strips color codes, raw or in the visible `^[` form, and fetch branch listings, then keeps the tail. */
export function compactCiLog(log: string, limit: number = compactLimit): string {
  // eslint-disable-next-line no-control-regex -- color codes start with the ESC control character.
  const plain = log.replace(/(?:\x1b|\^\[)\[[0-9;?]*[ -/]*[@-~]/g, "")
  const compact = plain.split("\n").filter(line => !/\s\* \[new (?:branch|tag)\]\s/.test(line)).join("\n")
  if (compact.length <= limit) return compact
  const start = compact.indexOf("\n", compact.length - limit) + 1
  let omitted = 0
  for (let n = compact.indexOf("\n"); n !== -1 && n < start; n = compact.indexOf("\n", n + 1)) omitted++
  return `[${omitted} earlier log lines omitted]\n${compact.slice(start)}`
}

/** Bound log context explicitly; the full fetched log remains in the local cache. */
export function diagnosticExcerpt(log: string, limit: number = 16_000, failedSteps: string[] = []): { excerpt: string, complete: boolean, totalLines: number, includedLineRanges: number[][], partialLines: number[] } {
  const lines = log.split("\n")
  if (log.length <= limit) return { excerpt: log, complete: true, totalLines: lines.length, includedLineRanges: [[1, lines.length]], partialLines: [] }
  const wanted = new Set<number>(), anchors = new Set<number>()
  const mark = (line: number) => { for (let n = Math.max(0, line - 4); n <= Math.min(lines.length - 1, line + 5); n++) wanted.add(n) }
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!
    if (/##\[error\]|\berror(?:\s|:|\[)|\bFAIL(?:ED)?\b|TypeError|AssertionError|exit code [1-9]|ELIFECYCLE|ERR_/i.test(line)
      || failedSteps.some(step => step && line.includes(step))) { anchors.add(n); mark(n) }
  }
  if (!wanted.size) for (let n = Math.max(0, lines.length - 80); n < lines.length; n++) wanted.add(n)
  const selected = new Map<number, string>(), included: number[] = [], partialLines: number[] = []
  let remaining = Math.max(0, limit)
  // Failure diagnostics are commonly emitted at the end of a job. Select the
  // newest diagnostic windows first, then restore source order for the excerpt.
  // This keeps a late assertion or exit-code line when an early warning-heavy
  // section would otherwise consume the entire budget.
  for (const n of [...anchors].sort((a, b) => b - a).concat([...wanted].filter(n => !anchors.has(n)).sort((a, b) => b - a))) {
    const prefix = selected.size ? "\n" : ""
    if (remaining <= prefix.length) break
    const line = lines[n]!, content = line.slice(0, remaining - prefix.length)
    selected.set(n + 1, content); included.push(n + 1); remaining -= prefix.length + content.length
    if (content.length < line.length) { partialLines.push(n + 1); break }
  }
  included.sort((a, b) => a - b)
  const chunks = included.map(lineNumber => selected.get(lineNumber)!)
  const includedLineRanges: number[][] = []
  for (const n of included) {
    const last = includedLineRanges.at(-1)
    if (last && last[1] === n - 1) last[1] = n
    else includedLineRanges.push([n, n])
  }
  return { excerpt: chunks.join("\n"), complete: false, totalLines: lines.length, includedLineRanges, partialLines }
}

/** Lines of a compacted log: the last `tailLines`, or `startLine` through `endLine` (at most 1000). */
export interface CheckLogSelection {
  startLine?: number
  endLine?: number
  tailLines?: number
}

const line = v.pipe(v.number(), v.integer(), v.minValue(1))
const selectionSchema = v.pipe(
  v.object({ startLine: v.optional(line), endLine: v.optional(line), tailLines: v.optional(v.pipe(line, v.maxValue(maxRangeLines))) }),
  v.check(input => input.tailLines === undefined || input.startLine === undefined && input.endLine === undefined, "Choose tailLines or startLine/endLine."),
  v.check(input => input.endLine === undefined || input.startLine !== undefined, "endLine requires startLine."),
  v.check(input => input.startLine === undefined || input.endLine === undefined || input.endLine >= input.startLine && input.endLine - input.startLine < maxRangeLines, `A log range must contain 1 to ${maxRangeLines} lines.`),
)

export interface CheckLogExcerpt {
  text: string
  truncated: boolean
  totalLines: number
  includedLineRanges: number[][]
  /** The first line after a requested range, when the log continues. */
  nextLine?: number
}

export function parseCheckLogSelection(input: unknown): CheckLogSelection {
  const result = v.safeParse(selectionSchema, input)
  if (!result.success) throw presetsErrorDiagnostics.PRESETS_CHECK_LOG_SELECTION_INVALID({ reason: result.issues[0].message })
  return result.output
}

/** A failure-focused excerpt of a compacted log, or the complete lines the selection names. */
export function checkLogExcerpt(log: string, limit: number, selection: CheckLogSelection = {}): CheckLogExcerpt {
  if (selection.startLine === undefined && selection.tailLines === undefined) {
    const excerpt = diagnosticExcerpt(log, limit)
    return { text: excerpt.excerpt, truncated: !excerpt.complete, totalLines: excerpt.totalLines, includedLineRanges: excerpt.includedLineRanges }
  }
  const lines = log.split("\n")
  const start = selection.tailLines === undefined ? selection.startLine! : Math.max(1, lines.length - selection.tailLines + 1)
  if (start > lines.length) throw presetsErrorDiagnostics.PRESETS_CHECK_LOG_START_PAST_END({ startLine: start, totalLines: lines.length })
  const end = selection.tailLines === undefined ? Math.min(lines.length, selection.endLine ?? start + maxRangeLines - 1) : lines.length
  return {
    text: lines.slice(start - 1, end).join("\n"),
    truncated: start > 1 || end < lines.length,
    totalLines: lines.length,
    includedLineRanges: [[start, end]],
    ...end < lines.length ? { nextLine: end + 1 } : {},
  }
}
