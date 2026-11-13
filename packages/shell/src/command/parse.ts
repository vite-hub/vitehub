import { BinCmdOperator, LangVariant, RedirOperator, createSourceIndex, walk, type File, type Stmt, type Word, type WordPart } from "sh-syntax"

import { shellErrorDiagnostics } from "../error-diagnostics.ts"
import { parseShell } from "./sh-syntax.ts"

type SourceIndex = (byteOffset: number) => number

export function wordText(word: Word, source: string, toIndex: SourceIndex = createSourceIndex(source)): string {
  return word.parts.map(part => wordPartText(part, source, toIndex, false)).join("")
}

function wordPartText(part: WordPart, source: string, toIndex: SourceIndex, doubleQuoted: boolean): string {
  switch (part.type) {
    case "Lit":
      return doubleQuoted ? unescapeDoubleQuoted(part.value) : unescapeUnquoted(part.value)
    case "SglQuoted":
      return part.value
    case "DblQuoted":
      return part.parts.map(nested => wordPartText(nested, source, toIndex, true)).join("")
    default:
      return source.slice(toIndex(part.start), toIndex(part.end))
  }
}

function unescapeUnquoted(value: string): string {
  return value.replace(/\\(\n|.)/gs, (_, next: string) => next === "\n" ? "" : next)
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

export async function parseShellCommand(command: string, mode: "execution" | "inspection" = "execution"): Promise<string[]> {
  let file
  try {
    file = await parseShell(command, {
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
  return stmt ? statementWords(stmt, command, createSourceIndex(command)) : []
}

function statementWords(stmt: Stmt, command: string, toIndex: SourceIndex, negated = stmt.negated): string[] {
  const words = commandWords(stmt, command, toIndex)
  return negated && words[0] !== "!" ? ["!", ...words] : words
}

function commandWords(stmt: Stmt, command: string, toIndex: SourceIndex): string[] {
  const call = stmt.cmd
  if (call?.type === "FuncDecl") return [`${call.name?.value ?? ""}()`]
  if (call?.type !== "CallExpr") {
    const firstToken = command.slice(toIndex(stmt.start), toIndex(stmt.end)).trim().match(/^\S+/)
    return firstToken ? [firstToken[0]] : []
  }

  return [
    ...call.assigns.map(assign => command.slice(toIndex(assign.start), toIndex(assign.end))),
    ...call.args.map(arg => wordText(arg, command, toIndex)),
    ...stmt.redirs.map(redir => command.slice(toIndex(redir.start), toIndex((redir.hdoc ? redir.word : redir)?.end ?? redir.end))),
  ]
}

export interface ShellCommandSegment {
  command: string
  followsPipe: boolean
  invalid?: boolean
  separatorAfter?: "&&" | "||" | "|" | ";" | "\n"
  words: string[]
}

interface StatementSeparator {
  kind: NonNullable<ShellCommandSegment["separatorAfter"]>
  offset: number
  length: number
}

export async function splitShellCommandSegments(command: string): Promise<ShellCommandSegment[]> {
  let file
  try {
    file = await parseShell(command, { keepComments: true, variant: LangVariant.LangBash })
  }
  catch {
    return [{ command, followsPipe: false, invalid: true, words: [] }]
  }
  const toIndex = createSourceIndex(command)
  // sh-syntax joins the next line to a comment that ends in a backslash. Bash does not.
  const scanned = withoutHeredocBodies(file, command, toIndex)
  if (scanned === undefined || stripLineContinuations(scanned).commentContinuation) {
    return [{ command, followsPipe: false, invalid: true, words: [] }]
  }
  const leaves: StatementLeaf[] = []
  file.stmts.forEach((stmt, index) => {
    flattenStatement(stmt, statementSeparator(file.stmts, index, command, toIndex), toIndex, leaves)
  })

  const segments: ShellCommandSegment[] = []
  let cursor = 0
  let followsPipe = false
  for (const { negated, stmt, separator } of leaves) {
    const trailingComment = stmt.comments.find(comment => comment.start >= stmt.end)
    const rawEnd = separator?.offset ?? (trailingComment ? toIndex(trailingComment.start) : toIndex(stmt.end))
    const raw = stripLineContinuations(command.slice(cursor, Math.max(cursor, rawEnd))).text
    segments.push({
      command: raw,
      followsPipe,
      ...(separator ? { separatorAfter: separator.kind } : {}),
      words: statementWords(stmt, command, toIndex, negated),
    })
    if (separator) cursor = separator.offset + separator.length
    followsPipe = separator?.kind === "|"
  }
  return segments
}

function withoutHeredocBodies(file: File, command: string, toIndex: SourceIndex): string | undefined {
  let result: string | undefined = command
  walk(file, (node) => {
    if (result === undefined) return false
    // An empty heredoc has no body range, so blank its terminator line instead.
    if (node.type === "Redirect" && !node.hdoc && (node.op === RedirOperator.Hdoc || node.op === RedirOperator.DashHdoc)) {
      result = withoutTerminatorLine(result, node.word ? wordText(node.word, command, toIndex) : "", toIndex(node.end), node.op === RedirOperator.DashHdoc)
      return result !== undefined
    }
    if (node.type === "Redirect" && node.hdoc) {
      const start = toIndex(node.hdoc.start)
      const end = toIndex(node.hdoc.end)
      result = result.slice(0, start) + " ".repeat(end - start) + result.slice(end)
    }
    return true
  })
  return result
}

function withoutTerminatorLine(source: string, delimiter: string, from: number, stripTabs: boolean): string | undefined {
  let start = source.indexOf("\n", from) + 1
  while (start > 0 && start < source.length) {
    const end = source.indexOf("\n", start) === -1 ? source.length : source.indexOf("\n", start)
    const line = source.slice(start, end)
    if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) {
      return source.slice(0, start) + " ".repeat(end - start) + source.slice(end)
    }
    start = end + 1
  }
}

interface StatementLeaf {
  negated: boolean
  separator?: StatementSeparator
  stmt: Stmt
}

function flattenStatement(
  stmt: Stmt,
  outer: StatementSeparator | undefined,
  toIndex: SourceIndex,
  leaves: StatementLeaf[],
  negated = false,
) {
  // `!` negates the whole pipeline or list, so it stays on the first command.
  if (stmt.cmd?.type === "BinaryCmd") {
    const operator = binaryOperator(stmt.cmd.op, toIndex(stmt.cmd.opPos.offset))
    flattenStatement(stmt.cmd.x!, operator, toIndex, leaves, negated || stmt.negated)
    flattenStatement(stmt.cmd.y!, outer, toIndex, leaves)
    return
  }
  leaves.push({ negated: negated || stmt.negated, stmt, ...(outer ? { separator: outer } : {}) })
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

function stripLineContinuations(command: string) {
  let result = ""
  let commentContinuation = false
  let quote: "'" | "\"" | undefined
  let ansiCQuoted = false
  let escaped = false
  let comment = false
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (comment) {
      result += char
      if (char === "\n") {
        comment = false
        if (command[index - 1] === "\\") commentContinuation = true
      }
      continue
    }
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
    if (char === "#" && (index === 0 || /[\s;|&()]/.test(command[index - 1]!))) {
      comment = true
      result += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
    }
    result += char
  }
  return { commentContinuation, text: result }
}
