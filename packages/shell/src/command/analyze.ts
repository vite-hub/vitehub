import { splitShellCommandSegments } from "./parse.ts"

import type { ShellAnalyzeOptions, ShellAnalyzeResult } from "../runtime/types.ts"
import { shellErrorDiagnostics } from "../error-diagnostics.ts"

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

  const segments = splitShellCommandSegments(command)
  const commands = [...new Set(segments.map(segment => firstCommandWord(segment.command)).filter(name => name !== undefined))]

  try {
    await withTimeout(parseWithShSyntax(command), options.timeoutMs ?? defaultTimeoutMs)
  }
  catch (error) {
    return {
      commands,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      parser: "sh-syntax",
    }
  }

  return {
    commands,
    hasCommandSubstitution: /(?:\$\(|`)/.test(command),
    hasHeredocs: /<<-?/.test(command),
    hasPipelines: segments.some(segment => segment.separatorAfter === "|" || segment.separatorAfter === "||"),
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
  if (timeoutMs <= 0) throw shellErrorDiagnostics.SHELL_R0001({ message: `Shell analysis timed out after ${timeoutMs}ms.` })
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(shellErrorDiagnostics.SHELL_R0002({ message: `Shell analysis timed out after ${timeoutMs}ms.` })), timeoutMs)
      }),
    ])
  }
  finally {
    if (timeout) clearTimeout(timeout)
  }
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
