import { BinCmdOperator, LangVariant, parseSync, type Stmt, type Word, type WordPart } from "sh-syntax"

import { shellErrorDiagnostics } from "../error-diagnostics.ts"

export function wordText(word: Word, source: string): string {
  return word.parts.map(part => wordPartText(part, source, false)).join("")
}

function wordPartText(part: WordPart, source: string, doubleQuoted: boolean): string {
  switch (part.type) {
    case "Lit":
      return doubleQuoted ? unescapeDoubleQuoted(part.value) : part.value
    case "SglQuoted":
      return part.value
    case "DblQuoted":
      return part.parts.map(nested => wordPartText(nested, source, true)).join("")
    default:
      return source.slice(part.start, part.end)
  }
}

function unescapeDoubleQuoted(value: string): string {
  let result = ""
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === "\\" && index + 1 < value.length && /[\\$`"\n]/.test(value[index + 1]!)) {
      const next = value[index + 1]!
      if (next !== "\n") result += next
      index += 1
      continue
    }
    result += char
  }
  return result
}

export function parseShellCommand(command: string, mode: "execution" | "inspection" = "execution"): string[] {
  let file
  try {
    file = parseSync(command, {
      recoverErrors: mode === "inspection" ? 1 : 0,
      variant: LangVariant.LangBash,
    })
  }
  catch (error) {
    if (mode === "inspection") return []
    throw shellErrorDiagnostics.SHELL_R0003({
      message: error instanceof Error ? error.message : "invalid shell command",
    })
  }

  const stmt = file.stmts[0]
  const call = stmt?.cmd
  if (call?.type !== "CallExpr") return []

  return [
    ...call.assigns.map(assign => command.slice(assign.start, assign.end)),
    ...call.args.map(arg => wordText(arg, command)),
    ...(stmt?.redirs ?? []).map(redir => command.slice(redir.start, redir.end)),
  ]
}

export interface ShellCommandSegment {
  command: string
  followsPipe: boolean
  separatorAfter?: "&&" | "||" | "|" | ";" | "\n"
}

interface StatementSeparator {
  kind: NonNullable<ShellCommandSegment["separatorAfter"]>
  offset: number
  length: number
}

export function splitShellCommandSegments(command: string): ShellCommandSegment[] {
  let file
  try {
    file = parseSync(command, { keepComments: true, variant: LangVariant.LangBash })
  }
  catch {
    return [{ command, followsPipe: false }]
  }

  const leaves: Array<{ stmt: Stmt, separator?: StatementSeparator }> = []
  file.stmts.forEach((stmt, index) => {
    flattenStatement(stmt, statementSeparator(file.stmts, index, command), leaves)
  })

  const segments: ShellCommandSegment[] = []
  let cursor = 0
  let followsPipe = false
  for (const { stmt, separator } of leaves) {
    const commentStart = stmt.comments[0]?.start
    const rawEnd = separator?.offset ?? commentStart ?? stmt.end
    const raw = stripLineContinuations(command.slice(cursor, Math.max(cursor, rawEnd)))
    segments.push({
      command: raw,
      followsPipe,
      ...(separator ? { separatorAfter: separator.kind } : {}),
    })
    if (separator) cursor = separator.offset + separator.length
    followsPipe = separator?.kind === "|"
  }
  return segments
}

function flattenStatement(
  stmt: Stmt,
  outer: StatementSeparator | undefined,
  leaves: Array<{ stmt: Stmt, separator?: StatementSeparator }>,
) {
  if (stmt.cmd?.type === "BinaryCmd") {
    const operator = binaryOperator(stmt.cmd.op, stmt.cmd.opPos.offset)
    flattenStatement(stmt.cmd.x!, operator, leaves)
    flattenStatement(stmt.cmd.y!, outer, leaves)
    return
  }
  leaves.push({ stmt, ...(outer ? { separator: outer } : {}) })
}

function statementSeparator(stmts: Stmt[], index: number, command: string): StatementSeparator | undefined {
  const stmt = stmts[index]!
  if (stmt.semicolon.offset > 0) return { kind: ";", offset: stmt.semicolon.offset, length: 1 }
  const next = stmts[index + 1]
  if (!next) return undefined
  for (let offset = stmt.end; offset < next.start; offset++) {
    if (command[offset] === "\n") return { kind: "\n", offset, length: 1 }
  }
  return undefined
}

function binaryOperator(op: number, offset: number): StatementSeparator | undefined {
  switch (op) {
    case BinCmdOperator.Pipe:
    case BinCmdOperator.PipeAll:
      return { kind: "|", offset, length: 1 }
    case BinCmdOperator.AndStmt:
      return { kind: "&&", offset, length: 2 }
    case BinCmdOperator.OrStmt:
      return { kind: "||", offset, length: 2 }
    default:
      return undefined
  }
}

function stripLineContinuations(command: string): string {
  let result = ""
  let quote: "'" | "\"" | undefined
  let ansiCQuoted = false
  let escaped = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (escaped) {
      if (char === "\n" && !ansiCQuoted) {
        result = result.slice(0, -1)
        escaped = false
        continue
      }
      result += char
      escaped = false
      continue
    }
    if (char === "\\" && (quote !== "'" || ansiCQuoted)) {
      result += char
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = undefined
        ansiCQuoted = false
      }
      result += char
      continue
    }
    if (char === "$" && command[index + 1] === "'") {
      quote = "'"
      ansiCQuoted = true
      result += "$'"
      index += 1
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
    }
    result += char
  }
  return result
}
