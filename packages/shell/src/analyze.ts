import type { ShellAnalyzeOptions, ShellAnalyzeResult } from "./types.ts"

const defaultMaxInputBytes = 64 * 1024
const defaultTimeoutMs = 100

export async function analyzeShellCommand(
  command: string,
  options: ShellAnalyzeOptions = {},
): Promise<ShellAnalyzeResult> {
  const maxInputBytes = options.maxInputBytes ?? defaultMaxInputBytes
  if (new TextEncoder().encode(command).byteLength > maxInputBytes) {
    return {
      error: `Shell command exceeds ${maxInputBytes} bytes.`,
      ok: false,
      parser: "sh-syntax",
    }
  }

  try {
    await withTimeout(parseWithShSyntax(command), options.timeoutMs ?? defaultTimeoutMs)
  }
  catch (error) {
    return {
      commands: detectCommandNames(command),
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      parser: "sh-syntax",
    }
  }

  return {
    commands: detectCommandNames(command),
    hasCommandSubstitution: /(?:\$\(|`)/.test(command),
    hasHeredocs: /<<-?/.test(command),
    hasPipelines: hasUnquoted(command, "|"),
    hasRedirects: /(?:^|[^<])(?:>>?|<)/.test(command),
    ok: true,
    parser: "sh-syntax",
  }
}

async function parseWithShSyntax(command: string) {
  const { parse, LangVariant } = await import("sh-syntax")
  await parse(command, { variant: LangVariant.LangBash })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`Shell analysis timed out after ${timeoutMs}ms.`)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Shell analysis timed out after ${timeoutMs}ms.`)), timeoutMs)
      }),
    ])
  }
  finally {
    if (timeout) clearTimeout(timeout)
  }
}

function detectCommandNames(command: string): string[] {
  const names: string[] = []
  for (const segment of splitCommandSegments(command)) {
    const name = firstCommandWord(segment)
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = []
  let current = ""
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    const next = command[index + 1]

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
    if (char === "|" || char === ";" || char === "\n" || (char === "&" && next === "&") || (char === "|" && next === "|")) {
      segments.push(current)
      current = ""
      if ((char === "&" || char === "|") && next === char) index += 1
      continue
    }
    current += char
  }

  segments.push(current)
  return segments
}

function firstCommandWord(segment: string): string | undefined {
  const words = segment.trim().match(/[^\s]+/g) || []
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (/^\d*(?:>>?|<<?-?|<&|>&)/.test(word)) continue
    return word.replace(/^command$/, "")
      || undefined
  }
}

function hasUnquoted(command: string, target: string): boolean {
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (const char of command) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      continue
    }
    if (char === target) return true
  }
  return false
}
