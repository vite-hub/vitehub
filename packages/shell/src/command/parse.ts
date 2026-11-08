import { BinCmdOperator, LangVariant, parseSync, type Stmt, type Word, type WordPart } from "sh-syntax"

import { shellErrorDiagnostics } from "../error-diagnostics.ts"

type SourceIndex = (byteOffset: number) => number

export function wordText(word: Word, source: string, toIndex = createSourceIndex(source)): string {
  return word.parts.map(part => wordPartText(part, source, toIndex, false)).join("")
}

function wordPartText(part: WordPart, source: string, toIndex: SourceIndex, doubleQuoted: boolean): string {
  switch (part.type) {
    case "Lit":
      return doubleQuoted ? unescapeDoubleQuoted(part.value) : part.value
    case "SglQuoted":
      return part.value
    case "DblQuoted":
      return part.parts.map(nested => wordPartText(nested, source, toIndex, true)).join("")
    default:
      return source.slice(toIndex(part.start), toIndex(part.end))
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

  const toIndex = createSourceIndex(command)
  return [
    ...call.assigns.map(assign => command.slice(toIndex(assign.start), toIndex(assign.end))),
    ...call.args.map(arg => wordText(arg, command, toIndex)),
    ...(stmt?.redirs ?? []).map(redir => command.slice(toIndex(redir.start), toIndex(redir.end))),
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

  const toIndex = createSourceIndex(command)
  const leaves: Array<{ stmt: Stmt, separator?: StatementSeparator }> = []
  file.stmts.forEach((stmt, index) => {
    flattenStatement(stmt, statementSeparator(file.stmts, index, command, toIndex), toIndex, leaves)
  })

  const segments: ShellCommandSegment[] = []
  let cursor = 0
  let followsPipe = false
  for (const { stmt, separator } of leaves) {
    const rawEnd = separator?.offset ?? (stmt.comments[0] ? toIndex(stmt.comments[0].start) : toIndex(stmt.end))
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
  toIndex: SourceIndex,
  leaves: Array<{ stmt: Stmt, separator?: StatementSeparator }>,
) {
  if (stmt.cmd?.type === "BinaryCmd") {
    const operator = binaryOperator(stmt.cmd.op, toIndex(stmt.cmd.opPos.offset))
    flattenStatement(stmt.cmd.x!, operator, toIndex, leaves)
    flattenStatement(stmt.cmd.y!, outer, toIndex, leaves)
    return
  }
  leaves.push({ stmt, ...(outer ? { separator: outer } : {}) })
}

function statementSeparator(
  stmts: Stmt[],
  index: number,
  command: string,
  toIndex: SourceIndex,
): StatementSeparator | undefined {
  const stmt = stmts[index]!
  if (stmt.semicolon.offset > 0) return { kind: ";", offset: toIndex(stmt.semicolon.offset), length: 1 }
  const next = stmts[index + 1]
  if (!next) return undefined
  for (let offset = toIndex(stmt.end); offset < toIndex(next.start); offset++) {
    if (command[offset] === "\n") return { kind: "\n", offset, length: 1 }
  }
  return undefined
}

function binaryOperator(op: number, offset: number): StatementSeparator | undefined {
  switch (op) {
    case BinCmdOperator.Pipe:
      return { kind: "|", offset, length: 1 }
    case BinCmdOperator.PipeAll:
      return { kind: "|", offset, length: 2 }
    case BinCmdOperator.AndStmt:
      return { kind: "&&", offset, length: 2 }
    case BinCmdOperator.OrStmt:
      return { kind: "||", offset, length: 2 }
    default:
      return undefined
  }
}

function createSourceIndex(source: string): SourceIndex {
  const indexes = [0]
  let byteOffset = 0
  for (let index = 0; index < source.length;) {
    const codePoint = source.codePointAt(index)!
    byteOffset += utf8Length(codePoint)
    index += codePoint > 0xffff ? 2 : 1
    indexes[byteOffset] = index
  }
  return offset => indexes[offset] ?? source.length
}

function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
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
