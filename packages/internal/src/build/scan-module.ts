/**
 * Reads facts from JavaScript and TypeScript modules at build and dev time. The scanner parses each module once with
 * the oxc parser that Vite ships through Rolldown, and never runs it. Values that are not static literals read as
 * `dynamic`, so callers can report their own diagnostics.
 */
import { parseSync } from "vite"

import type { ESTree } from "vite"

export type Argument = ESTree.Argument
export type CallExpression = ESTree.CallExpression
export type NewExpression = ESTree.NewExpression
export type Comment = ReturnType<typeof parseSync>["comments"][number]
export type Expression = ESTree.Expression
export type Node = ESTree.Node
export type ObjectExpression = ESTree.ObjectExpression
export type ObjectProperty = ESTree.ObjectProperty
export type Program = ESTree.Program
export type SpreadElement = ESTree.SpreadElement
export type TemplateLiteral = ESTree.TemplateLiteral

export interface ScannedModule {
  readonly file: string
  readonly source: string
  readonly program: Program
  readonly comments: readonly Comment[]
  /** Syntax errors. The program is partial or empty when this list is not empty. */
  readonly errors: readonly { message: string }[]
}

/** The value of an expression that the scanner cannot read without running the module. */
export const dynamic: unique symbol = Symbol("dynamic")
export type Dynamic = typeof dynamic

export type StaticValue = string | number | boolean | bigint | null | undefined | StaticValue[] | { [key: string]: StaticValue }

function languageOf(file: string): "js" | "jsx" | "ts" | "tsx" {
  if (/\.(?:c|m)?tsx$/i.test(file)) return "tsx"
  if (/\.(?:c|m)?jsx$/i.test(file)) return "jsx"
  if (/\.(?:c|m)?js$/i.test(file)) return "js"
  return "ts"
}

/** Parses a module once. `file` selects the grammar from its extension and defaults to TypeScript. */
export function scanModule(source: string, file = "module.ts"): ScannedModule {
  const result = parseSync(file, source, { lang: languageOf(file), preserveParens: false, sourceType: "module" })
  return { comments: result.comments, errors: result.errors, file, program: result.program, source }
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
}

/** Visits `node` and its descendants. Return `false` from `visit` to skip the children of a node. */
export function walk(node: Node, visit: (node: Node, parent: Node | undefined) => boolean | void, parent?: Node): void {
  if (visit(node, parent) === false) return
  // SAFETY: AST nodes are plain objects. Reading their fields by key only selects child nodes and arrays.
  const fields = node as unknown as Record<string, unknown>
  for (const key in fields) {
    const child = fields[key]
    if (typeof child !== "object" || child === null || key === "parent") continue
    if (Array.isArray(child)) {
      for (const item of child) if (isNode(item)) walk(item, visit, node)
    }
    else if (isNode(child)) walk(child, visit, node)
  }
}

/** The source text of a node. */
export function nodeText(module: ScannedModule, node: Node): string {
  return module.source.slice(node.start, node.end)
}

/** Removes parentheses, `as`, `satisfies`, `!`, and `<T>` assertions around an expression. */
export function unwrapExpression(node: Expression): Expression {
  while (
    node.type === "ParenthesizedExpression"
    || node.type === "TSAsExpression"
    || node.type === "TSSatisfiesExpression"
    || node.type === "TSNonNullExpression"
    || node.type === "TSTypeAssertion"
  ) node = node.expression
  return node
}

/** A call argument without assertions, or undefined for a spread or missing argument. */
export function argumentExpression(argument: Argument | undefined): Expression | undefined {
  return argument === undefined || argument.type === "SpreadElement" ? undefined : unwrapExpression(argument)
}

/** Calls whose callee is a plain identifier in `names`, such as `defineCollection(...)`, in source order. */
export function findCalls(module: ScannedModule, names: Iterable<string>): CallExpression[] {
  const wanted = new Set(names)
  const calls: CallExpression[] = []
  walk(module.program, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && wanted.has(node.callee.name)) calls.push(node)
  })
  return calls.sort((left, right) => left.start - right.start)
}

/** The expression of `export default <expression>`, without assertions. Declarations return undefined. */
export function defaultExportExpression(module: ScannedModule): Expression | undefined {
  for (const statement of module.program.body) {
    if (statement.type !== "ExportDefaultDeclaration") continue
    const declaration = statement.declaration
    if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration" || declaration.type === "TSInterfaceDeclaration") return
    return unwrapExpression(declaration)
  }
}

export interface DefaultExportCall {
  call: CallExpression
  name: string
  /** The options object literal. Undefined when the call uses positional arguments and has no options argument. */
  options?: ObjectExpression
}

/**
 * Finds `export default defineX({ ... })` for one of `names`. With `positionalOptionsIndex`, a call whose first
 * argument is not an object and that has more than one argument reads its options from that argument. Returns
 * undefined when the options are not an object literal.
 */
export function findDefaultExportCall(module: ScannedModule, names: readonly string[], options: { positionalOptionsIndex?: number } = {}): DefaultExportCall | undefined {
  const call = defaultExportExpression(module)
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier" || !names.includes(call.callee.name)) return
  const name = call.callee.name
  const first = argumentExpression(call.arguments[0])
  if (first?.type === "ObjectExpression") return { call, name, options: first }
  // The positional form has more than one argument, such as `defineSchedule(cron, handler, options)`.
  if (options.positionalOptionsIndex === undefined || first === undefined || call.arguments.length < 2) return
  const positional = call.arguments[options.positionalOptionsIndex]
  if (positional === undefined) return { call, name }
  const object = argumentExpression(positional)
  return object?.type === "ObjectExpression" ? { call, name, options: object } : undefined
}

/** One member of an object literal. */
export interface StaticProperty {
  /** True for a computed key such as `["name"]`, even when the key is a literal. */
  computed: boolean
  /** The static key. Undefined for a spread, or for a computed key that is not a string or number literal. */
  key: string | undefined
  node: ObjectProperty | SpreadElement
  /** The value without assertions. Methods and accessors give their function. Undefined for a spread. */
  value: Expression | undefined
}

function staticKey(property: ObjectProperty): string | undefined {
  const key = property.key
  if (key.type === "Identifier" && !property.computed) return key.name
  if (key.type === "PrivateIdentifier") return
  const value = staticValue(key)
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : undefined
}

/** The members of an object literal in source order. */
export function objectProperties(object: ObjectExpression): StaticProperty[] {
  return object.properties.map(node => node.type === "SpreadElement"
    ? { computed: false, key: undefined, node, value: undefined }
    : { computed: node.computed, key: staticKey(node), node, value: unwrapExpression(node.value) })
}

/** The last member named `name`, which is the one that the object keeps at runtime. */
export function findProperty(object: ObjectExpression, name: string): StaticProperty | undefined {
  return objectProperties(object).findLast(property => property.key === name)
}

/** The value of a template literal without substitutions. */
function staticTemplate(node: TemplateLiteral): string | Dynamic {
  if (node.expressions.length) return dynamic
  return node.quasis[0]?.value.cooked ?? dynamic
}

const escapePattern = /\\(u\{[^}]*\}?|u[\s\S]{0,4}|x[\s\S]{0,2}|0\d|[\s\S])/g

/**
 * True when a string literal has an escape that strict mode code rejects. The parser recovers from some bad escapes
 * and accepts legacy octal escapes, so the scanner checks them again.
 */
function hasInvalidEscape(raw: string): boolean {
  for (const [, escape = ""] of raw.matchAll(escapePattern)) {
    if (escape.startsWith("u{")) {
      const code = escape.slice(2, -1)
      if (!escape.endsWith("}") || !/^[\da-fA-F]+$/.test(code) || Number.parseInt(code, 16) > 0x10FFFF) return true
    }
    else if (escape.startsWith("u")) {
      if (!/^u[\da-fA-F]{4}$/.test(escape)) return true
    }
    else if (escape.startsWith("x")) {
      if (!/^x[\da-fA-F]{2}$/.test(escape)) return true
    }
    else if (/^(?:[1-9]|0\d)$/.test(escape)) return true
  }
  return false
}

/**
 * Reads a literal value: strings, numbers, booleans, `null`, `undefined`, template literals without substitutions,
 * and arrays and objects of these. Any other expression gives `dynamic`.
 */
export function staticValue(node: Expression): StaticValue | Dynamic {
  node = unwrapExpression(node)
  switch (node.type) {
    case "Literal":
      if ("regex" in node) return dynamic
      return typeof node.value === "string" && hasInvalidEscape(node.raw ?? "") ? dynamic : node.value
    case "TemplateLiteral":
      return staticTemplate(node)
    case "Identifier":
      return node.name === "undefined" ? undefined : dynamic
    case "UnaryExpression": {
      if (node.operator === "void") return staticValue(node.argument) === dynamic ? dynamic : undefined
      const value = staticValue(node.argument)
      if (node.operator === "-" && (typeof value === "number" || typeof value === "bigint")) return -value
      return dynamic
    }
    case "ArrayExpression": {
      const values: StaticValue[] = []
      for (const element of node.elements) {
        if (element === null || element.type === "SpreadElement") return dynamic
        const value = staticValue(element)
        if (value === dynamic) return dynamic
        values.push(value)
      }
      return values
    }
    case "ObjectExpression": {
      const values: { [key: string]: StaticValue } = {}
      for (const property of objectProperties(node)) {
        if (property.key === undefined || property.node.type !== "Property" || property.node.kind !== "init" || property.node.method || property.value === undefined) return dynamic
        const value = staticValue(property.value)
        if (value === dynamic) return dynamic
        Object.defineProperty(values, property.key, { configurable: true, enumerable: true, value, writable: true })
      }
      return values
    }
    default:
      return dynamic
  }
}

/** The static string value of an expression, or undefined when it is not a string literal. */
export function staticString(node: Expression | undefined): string | undefined {
  if (node === undefined) return
  const value = staticValue(node)
  return typeof value === "string" ? value : undefined
}

function isLineTerminator(char: string): boolean {
  return char === "\n" || char === "\r" || char === " " || char === " "
}

interface Span {
  end: number
  /** Comments and JSX text are not code tokens. */
  inert: boolean
  start: number
}

/** Comments, JSX text, and string, template, and regular expression literals, sorted by position. Templates are not split. */
function literalSpans(module: ScannedModule): Span[] {
  const spans: Span[] = module.comments.map(comment => ({ end: comment.end, inert: true, start: comment.start }))
  walk(module.program, (node) => {
    if (node.type === "TemplateLiteral" || node.type === "JSXText") {
      spans.push({ end: node.end, inert: node.type === "JSXText", start: node.start })
      return false
    }
    if (node.type === "Literal" && (typeof node.value === "string" || "regex" in node)) spans.push({ end: node.end, inert: false, start: node.start })
  })
  return spans.sort((left, right) => left.start - right.start)
}

/**
 * The module source with comments, strings, templates, regular expressions, and JSX text replaced by spaces. Line
 * terminators and all positions stay the same, so text matches map back to the source.
 */
export function maskLiterals(module: ScannedModule): string {
  const output = module.source.split("")
  for (const span of literalSpans(module)) {
    for (let index = span.start; index < span.end; index++) {
      if (!isLineTerminator(output[index] ?? "")) output[index] = " "
    }
  }
  return output.join("")
}

export interface ModuleTokens {
  /** Indexes of tokens that follow a line terminator. */
  lineBreaks: Set<number>
  /** Tokens in source order. Comments are removed. Strings, templates, and regular expressions are single tokens. */
  tokens: string[]
}

const codeTokenPattern = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?|(?:[\p{ID_Start}$_]|\\u\{[\da-fA-F]+\}|\\u[\da-fA-F]{4})(?:[\p{ID_Continue}$‌‍]|\\u\{[\da-fA-F]+\}|\\u[\da-fA-F]{4})*|\S/gu

function decodeIdentifier(token: string): string {
  return token.replace(/\\u(?:\{([\da-fA-F]+)\}|([\da-fA-F]{4}))/g, (_escape, point: string | undefined, unit: string | undefined) => String.fromCodePoint(Number.parseInt(point ?? unit ?? "0", 16)))
}

/**
 * Splits a module into tokens. The parser finds literals and comments, so a `/` is never confused between division
 * and a regular expression. Identifier escapes are decoded.
 */
export function moduleTokens(module: ScannedModule): ModuleTokens {
  const { source } = module
  const tokens: string[] = []
  const lineBreaks = new Set<number>()
  let previousEnd = 0
  const push = (token: string, start: number) => {
    for (let index = previousEnd; index < start; index++) {
      if (isLineTerminator(source[index] ?? "")) {
        lineBreaks.add(tokens.length)
        break
      }
    }
    tokens.push(token)
    previousEnd = start + token.length
  }
  const scanCode = (start: number, end: number) => {
    const pattern = new RegExp(codeTokenPattern.source, codeTokenPattern.flags)
    const code = source.slice(start, end)
    for (const match of code.matchAll(pattern)) {
      const token = match[0]
      push(/^[\p{ID_Start}$_\\]/u.test(token) ? decodeIdentifier(token) : token, start + match.index)
      previousEnd = start + match.index + token.length
    }
  }
  let cursor = 0
  for (const span of literalSpans(module)) {
    if (span.start < cursor) continue
    scanCode(cursor, span.start)
    if (!span.inert) push(source.slice(span.start, span.end), span.start)
    cursor = span.end
  }
  scanCode(cursor, source.length)
  return { lineBreaks, tokens }
}

/** The source of each `${...}` substitution in a template literal, such as the source of one template token. */
export function templateExpressionSources(template: string): string[] {
  const module = scanModule(`(${template})`)
  const statement = module.program.body[0]
  if (statement?.type !== "ExpressionStatement") return []
  const expression = unwrapExpression(statement.expression)
  const literal = expression.type === "TaggedTemplateExpression" ? expression.quasi : expression
  if (literal.type !== "TemplateLiteral") return []
  // Template element spans include the `${` and `}` delimiters. Keep the whitespace and comments between them.
  return literal.expressions.map((_node, index) => module.source.slice(literal.quasis[index]?.end ?? 0, literal.quasis[index + 1]?.start ?? 0))
}
