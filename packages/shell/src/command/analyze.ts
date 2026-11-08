import { BinCmdOperator, LangVariant, parse, walk, type File, type Stmt } from "sh-syntax"

import { createSourceIndex, wordText } from "./parse.ts"

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
  return parse(command, { keepComments: true, variant: LangVariant.LangBash })
}

function analyzeAst(file: File, command: string) {
  const commands: string[] = []
  const toIndex = createSourceIndex(command)
  collectTopLevelCommands(file.stmts, command, toIndex, commands)
  let hasCommandSubstitution = false
  let hasHeredocs = false
  let hasPipelines = false
  let hasRedirects = false

  walk(file, (node) => {
    switch (node.type) {
      case "CmdSubst":
        hasCommandSubstitution = true
        break
      case "Redirect":
        hasRedirects = true
        if (node.hdoc) hasHeredocs = true
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

function collectTopLevelCommands(stmts: Stmt[], command: string, toIndex: (offset: number) => number, commands: string[]) {
  for (const stmt of stmts) {
    collectStatementCommand(stmt, command, toIndex, commands)
  }
}

function collectStatementCommand(
  stmt: Stmt | null,
  command: string,
  toIndex: (offset: number) => number,
  commands: string[],
) {
  const cmd = stmt?.cmd
  if (!cmd) return
  if (cmd.type === "CallExpr") {
    if (cmd.args.length) commands.push(wordText(cmd.args[0]!, command, toIndex))
    return
  }
  if (cmd.type === "DeclClause") {
    if (cmd.variant) commands.push(cmd.variant.value)
    return
  }
  if (cmd.type === "LetClause") {
    commands.push("let")
    return
  }
  if (cmd.type === "BinaryCmd") {
    collectStatementCommand(cmd.x, command, toIndex, commands)
    collectStatementCommand(cmd.y, command, toIndex, commands)
  }
}
