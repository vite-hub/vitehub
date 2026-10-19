import { shellErrorDiagnostics } from "../error-diagnostics.ts"

export function parseShellCommand(command: string, mode: "execution" | "inspection" = "execution"): string[] {
  const words: string[] = []
  let current = ""
  let wordStarted = false
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (escaped) {
      if (char !== "\n") {
        current += char
        wordStarted = true
      }
      escaped = false
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else {
        if (char === "\\" && quote === '"' && /[\\$`"\n]/.test(command[index + 1] ?? "")) escaped = true
        else current += char
      }
      wordStarted = true
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      wordStarted = true
      continue
    }
    if (/\s/.test(char)) {
      if (wordStarted) {
        words.push(current)
        current = ""
        wordStarted = false
      }
      continue
    }
    current += char
    wordStarted = true
  }

  if (mode === "execution") {
    if (escaped) {
      current += "\\"
      wordStarted = true
    }
    if (quote) throw shellErrorDiagnostics.SHELL_R0003({ message: "unterminated quote" })
  }
  if (wordStarted) words.push(current)
  return words
}

export function splitShellCommandSegments(command: string) {
  const segments: Array<{ command: string, followsPipe: boolean, separatorAfter?: "&&" | "||" | "|" | ";" | "\n" }> = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  let comment = false
  let wordBoundary = true
  let followsPipe = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (comment) {
      if (char !== "\n") continue
      comment = false
    }
    if (escaped) {
      if (char === "\n") {
        escaped = false
        continue
      }
      current += char
      wordBoundary = false
      escaped = false
      continue
    }
    if (char === "\\") {
      current += char
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      current += char
      wordBoundary = false
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      current += char
      wordBoundary = false
      continue
    }
    if (char === "#" && wordBoundary) {
      comment = true
      continue
    }
    const next = command[index + 1]
    if (char === "&" && next === "&") {
      segments.push({ command: current, followsPipe, separatorAfter: "&&" })
      current = ""
      followsPipe = false
      wordBoundary = true
      index += 1
      continue
    }
    if (char === "|" && next === "|") {
      segments.push({ command: current, followsPipe, separatorAfter: "||" })
      current = ""
      followsPipe = false
      wordBoundary = true
      index += 1
      continue
    }
    if (char === "|" || char === ";" || char === "\n") {
      segments.push({ command: current, followsPipe, separatorAfter: char })
      current = ""
      followsPipe = char === "|"
      wordBoundary = true
      continue
    }
    current += char
    wordBoundary = /[\s()<>]/.test(char) || char === "&"
  }
  segments.push({ command: current, followsPipe })
  return segments
}
