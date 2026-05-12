import type { CILogLine } from "../types.ts"

const DEFAULT_TERMS = [
  "error",
  "failed",
  "exception",
  "traceback",
  "npm err!",
  "pnpm",
  "yarn",
  "wrangler error",
  "build failed",
  "typeerror",
  "syntaxerror",
]

export function extractLikelyCIError(lines: CILogLine[], options: {
  contextLines?: number
  fallbackLineCount?: number
} = {}): string {
  const contextLines = options.contextLines ?? 4
  const fallbackLineCount = options.fallbackLineCount ?? 80
  const matchIndex = findLastHighSignalLine(lines)

  if (matchIndex >= 0) {
    const start = Math.max(0, matchIndex - contextLines)
    const end = Math.min(lines.length, matchIndex + contextLines + 1)
    return formatLines(lines.slice(start, end))
  }

  return formatLines(lines.slice(Math.max(0, lines.length - fallbackLineCount)))
}

function findLastHighSignalLine(lines: CILogLine[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const message = lines[index]?.message.toLowerCase() ?? ""
    if (DEFAULT_TERMS.some((term) => message.includes(term))) {
      return index
    }
  }
  return -1
}

function formatLines(lines: CILogLine[]): string {
  return lines.map((line) => line.timestamp ? `[${line.timestamp}] ${line.message}` : line.message).join("\n")
}

