import { end, indentAt, start, walk } from "@vite-hub/internal/ast"
import { parse as parseSfc } from "@vue/compiler-sfc"

import type { CallExpression, File } from "@babel/types"
import type { CodeStyle, Node } from "@vite-hub/internal/ast"
import type MagicString from "magic-string"

/** One script of a source file: the whole file, or one `<script>` block of a `.vue` file. */
export interface ScriptBlock {
  code: string
  offset: number
  lineOffset: number
  jsx: boolean
  typescript: boolean
}

export function scriptBlocks(file: string, source: string): ScriptBlock[] {
  if (!file.endsWith(".vue")) {
    return [{ code: source, offset: 0, lineOffset: 0, jsx: /\.[jt]sx$/.test(file), typescript: !/\.(?:c|m)?jsx?$/.test(file) }]
  }
  const { descriptor } = parseSfc(source, { filename: file })
  return [descriptor.script, descriptor.scriptSetup].flatMap((block) => {
    if (!block || block.src) return []
    const lang = block.lang ?? "js"
    return [{
      code: block.content,
      offset: block.loc.start.offset,
      lineOffset: block.loc.start.line - 1,
      jsx: lang === "tsx" || lang === "jsx",
      typescript: lang === "ts" || lang === "tsx",
    }]
  })
}

export interface ResultCallContext {
  block: ScriptBlock
  output: MagicString
  program: File
  style: CodeStyle
}

/** A call that returns `[error, data]` now, and threw before. */
export interface ResultCall {
  /** The name of the error variable, such as `checkRateLimitError`. A number is added when the name is taken. */
  error: string
  /** The name of the value variable when the code reads the value in the same statement, such as `decision`. */
  value: string
  /** Names the error after the variable of `const run = await call(...)`, such as `runError`, in place of `error`. */
  errorAfterValue?: boolean
}

/** Names that a declaration, parameter, or import in `program` binds. */
function declaredNames(program: File): Set<string> {
  const names = new Set<string>()
  walk(program, (node) => {
    if (node.type === "Identifier") names.add(node.name)
  })
  return names
}

/** Whether `child` is the part of `parent` that runs first, so the code can read it in a statement before. */
function runsFirst(parent: Node, child: Node): boolean {
  switch (parent.type) {
    case "UnaryExpression":
    case "TSAsExpression":
    case "TSNonNullExpression":
    case "TSSatisfiesExpression":
      return true
    case "MemberExpression":
      return parent.object === child
    case "BinaryExpression":
    case "LogicalExpression":
      return parent.left === child
    case "ConditionalExpression":
      return parent.test === child
    case "CallExpression":
      // `f(await checkRateLimit(...))` reads `f` first, which has no side effect when it is a name or a property path.
      return parent.callee === child || (parent.arguments[0] === child && isNamePath(parent.callee))
    default:
      return false
  }
}

function isNamePath(node: Node): boolean {
  if (node.type === "Identifier") return true
  return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && isNamePath(node.object)
}

/** The statement that runs `node` before anything else, when it is in a statement list. */
function leadingStatement(node: Node, ancestors: readonly Node[]): Node | undefined {
  let child = node
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const parent = ancestors[index]!
    const owner = ancestors[index - 1]
    const inList = owner && (owner.type === "BlockStatement" || owner.type === "Program") && (owner.body as readonly Node[]).includes(parent)
    switch (parent.type) {
      case "ExpressionStatement":
        return inList && parent.expression === child ? parent : undefined
      case "ReturnStatement":
      case "ThrowStatement":
        return inList && parent.argument === child ? parent : undefined
      case "IfStatement":
        return inList && parent.test === child ? parent : undefined
      case "VariableDeclarator":
        if (parent.init !== child || owner?.type !== "VariableDeclaration" || owner.declarations[0] !== parent) return undefined
        child = parent
        continue
      case "VariableDeclaration":
        return inList ? parent : undefined
    }
    if (!runsFirst(parent, child)) return undefined
    child = parent
  }
  return undefined
}

/** Whether the code already reads the Result, as in `const [error, run] = await call(...)`. */
function readsResult(awaited: Node, parent: Node | undefined): boolean {
  if (parent?.type === "VariableDeclarator") return parent.init === awaited && parent.id.type === "ArrayPattern"
  if (parent?.type === "AssignmentExpression") return parent.right === awaited && parent.left.type === "ArrayPattern"
  return false
}

const functionTypes = new Set(["ArrowFunctionExpression", "ClassMethod", "ClassPrivateMethod", "FunctionDeclaration", "FunctionExpression", "ObjectMethod"])

/** Whether the nearest function around the last ancestor is `async`. */
function inAsyncFunction(ancestors: readonly Node[]): boolean {
  const fn = ancestors.findLast(node => functionTypes.has(node.type))
  return Boolean(fn && "async" in fn && fn.async)
}

/**
 * The source range of `node`, with one pair of parentheses around it, such as `(await checkRateLimit(...))`. Other
 * parentheses, or a comment beside them, stay: an identifier in their place is valid code too.
 */
function rangeWithParentheses(code: string, node: Node): [number, number] {
  const extra = node.extra as { parenthesized?: boolean, parenStart?: number } | undefined
  const close = /^\s*\)/.exec(code.slice(end(node)))
  if (!extra?.parenthesized || extra.parenStart === undefined || !close || !/^\(\s*$/.test(code.slice(extra.parenStart, start(node)))) return [start(node), end(node)]
  return [extra.parenStart, end(node) + close[0].length]
}

/**
 * Rewrites each awaited call that `match` accepts into a Result read that throws the error, which keeps the behavior
 * of code written for a call that threw:
 * - `const value = await call(...)` becomes `const [error, value] = await call(...)`.
 * - `await call(...)` as a statement becomes `const [error] = await call(...)`.
 * - A call that its statement runs first, such as `return await call(...)` or `if (!(await call(...)).ok)`, moves to a
 *   `const` before the statement, and the statement reads the value. `return call(...)` in an async function does too.
 * Each line is followed by `if (error) throw error`. `unsupported` gets the other calls, such as a call without
 * `await` or one inside a larger expression. Returns the number of rewritten calls.
 */
export function rewriteResultCalls(
  context: ResultCallContext,
  match: (call: CallExpression) => ResultCall | undefined,
  unsupported: (call: CallExpression) => void,
): number {
  const { block, output, program, style } = context
  let taken: Set<string> | undefined
  const freeName = (base: string) => {
    taken ??= declaredNames(program)
    let index = 1
    let name = base
    while (taken.has(name)) name = `${base}${++index}`
    taken.add(name)
    return name
  }
  let rewritten = 0
  walk(program, (node, ancestors) => {
    if (node.type !== "CallExpression") return
    const call = match(node)
    if (!call) return
    const parent = ancestors.at(-1)
    if (parent?.type === "AwaitExpression" && readsResult(parent, ancestors.at(-2))) return
    // `return call(...)` in an async function waits for the call as `return await call(...)` does.
    const awaited = parent?.type === "AwaitExpression" ? parent : parent?.type === "ReturnStatement" && inAsyncFunction(ancestors) ? node : undefined
    const statement = awaited ? leadingStatement(awaited, awaited === parent ? ancestors.slice(0, -1) : ancestors) : undefined
    if (!awaited || !statement) {
      unsupported(node)
      return
    }
    const declarator = statement.type === "VariableDeclaration" && statement.declarations.length === 1 ? statement.declarations[0] : undefined
    const id = declarator?.init === awaited ? declarator.id : undefined
    const named = id?.type === "Identifier" && !id.typeAnnotation
    const error = freeName(call.errorAfterValue && named ? `${id.name}Error` : call.error)
    const semicolon = style.semicolons || block.code[end(statement) - 1] === ";" ? ";" : ""
    const indent = indentAt(block.code, start(statement))
    const check = `if (${error}) throw ${error}${semicolon}`
    const awaitedCode = `${awaited === node ? "await " : ""}${block.code.slice(start(awaited), end(awaited))}`
    // A pattern such as `const { id } = ...` would read the value before the error check, so it takes the last branch.
    if (named) {
      // `const value = await call(...)` keeps its statement.
      output.overwrite(block.offset + start(id), block.offset + end(id), `[${error}, ${block.code.slice(start(id), end(id))}]`)
      output.appendLeft(block.offset + end(statement), `\n${indent}${check}`)
    }
    else if (statement.type === "ExpressionStatement" && statement.expression === awaited) {
      // A call whose value nobody reads only throws its error.
      output.overwrite(block.offset + start(statement), block.offset + end(statement), `const [${error}] = ${awaitedCode}${semicolon}\n${indent}${check}`)
    }
    else {
      const value = freeName(call.value)
      const [from, to] = rangeWithParentheses(block.code, awaited)
      output.appendLeft(block.offset + start(statement), `const [${error}, ${value}] = ${awaitedCode}${semicolon}\n${indent}${check}\n${indent}`)
      output.overwrite(block.offset + from, block.offset + to, value)
    }
    rewritten++
  })
  return rewritten
}
