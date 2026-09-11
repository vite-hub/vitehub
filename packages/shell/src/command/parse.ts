import { shellErrorDiagnostics } from "../error-diagnostics.ts"

export function parseShellCommand(command: string, mode: "execution" | "inspection" = "execution"): string[] {
  const words: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (const char of command) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (mode === "execution") {
    if (escaped) current += "\\"
    if (quote) throw shellErrorDiagnostics.SHELL_R0003({ message: "unterminated quote" })
  }
  if (current) words.push(current)
  return words
}

export function splitShellCommandSegments(command: string) {
  const segments: Array<{ command: string, followsPipe: boolean, separatorAfter?: "&&" | "||" | "|" | ";" | "\n" }> = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false
  let followsPipe = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (escaped) {
      current += char
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
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      current += char
      continue
    }
    const next = command[index + 1]
    if (char === "&" && next === "&") {
      segments.push({ command: current, followsPipe, separatorAfter: "&&" })
      current = ""
      followsPipe = false
      index += 1
      continue
    }
    if (char === "|" && next === "|") {
      segments.push({ command: current, followsPipe, separatorAfter: "||" })
      current = ""
      followsPipe = false
      index += 1
      continue
    }
    if (char === "|" || char === ";" || char === "\n") {
      segments.push({ command: current, followsPipe, separatorAfter: char })
      current = ""
      followsPipe = char === "|"
      continue
    }
    current += char
  }
  segments.push({ command: current, followsPipe })
  return segments
}
