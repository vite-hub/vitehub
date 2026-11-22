import { BinCmdOperator, LangVariant, RedirOperator, createSourceIndex, walk, type File } from "sh-syntax"

import { wordText } from "./parse.ts"
import { parseShell } from "./sh-syntax.ts"

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

  try {
    const file = await withTimeout(parseWithShSyntax(command), options.timeoutMs ?? defaultTimeoutMs)
    const metadata = analyzeAst(file, command)
    return {
      ...metadata,
      ok: true,
      parser: "sh-syntax",
    }
  }
  catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      ok: false,
      parser: "sh-syntax",
    }
  }
}

async function parseWithShSyntax(command: string) {
  return parseShell(command, { keepComments: true, variant: LangVariant.LangBash })
}

function analyzeAst(file: File, command: string) {
  const commands: string[] = []
  const toIndex = createSourceIndex(command)
  let hasCommandSubstitution = false
  let hasHeredocs = false
  let hasPipelines = false
  let hasRedirects = false

  walk(file, (node) => {
    switch (node.type) {
      case "CallExpr":
        if (node.args.length) commands.push(wordText(node.args[0]!, command, toIndex))
        break
      case "DeclClause":
        if (node.variant) commands.push(node.variant.value)
        break
      case "LetClause":
        commands.push("let")
        break
      case "CmdSubst":
        hasCommandSubstitution = true
        break
      case "Redirect":
        hasRedirects = true
        if (node.op === RedirOperator.Hdoc || node.op === RedirOperator.DashHdoc) hasHeredocs = true
        break
      case "BinaryCmd":
        if (node.op === BinCmdOperator.Pipe || node.op === BinCmdOperator.PipeAll || node.op === BinCmdOperator.OrStmt) hasPipelines = true
        break
    }
    return true
  })

  return {
    commands: [...new Set(commands.filter(Boolean))],
    hasCommandSubstitution,
    hasHeredocs,
    hasPipelines,
    hasRedirects,
  }
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
