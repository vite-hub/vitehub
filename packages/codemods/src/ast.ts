import { parse } from "@babel/parser"

import type { ParserPlugin } from "@babel/parser"
import type { Expression, File, Identifier, Node, ObjectExpression, ObjectProperty, PrivateName, StringLiteral } from "@babel/types"

export type { Node }

/** Parses JavaScript or TypeScript. `jsx` adds JSX syntax. */
export function parseProgram(code: string, options: { jsx?: boolean, typescript?: boolean } = {}): File {
  const plugins: ParserPlugin[] = []
  if (options.typescript !== false) plugins.push("typescript")
  if (options.jsx) plugins.push("jsx")
  return parse(code, { sourceType: "module", plugins, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
}

export function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
    && "start" in value && typeof value.start === "number"
}

const skippedKeys = new Set(["leadingComments", "trailingComments", "innerComments", "loc", "extra"])

/** Visits every node depth first. `ancestors` ends with the direct parent. */
export function walk(root: Node, visit: (node: Node, ancestors: readonly Node[]) => void): void {
  const ancestors: Node[] = []
  const visitNode = (node: Node) => {
    visit(node, ancestors)
    ancestors.push(node)
    for (const [key, child] of Object.entries(node)) {
      if (skippedKeys.has(key)) continue
      const value: unknown = child
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) visitNode(item)
      }
      else if (isNode(value)) {
        visitNode(value)
      }
    }
    ancestors.pop()
  }
  visitNode(root)
}

export function start(node: Node): number {
  if (typeof node.start !== "number") throw new TypeError(`Node ${node.type} has no start position`)
  return node.start
}

export function end(node: Node): number {
  if (typeof node.end !== "number") throw new TypeError(`Node ${node.type} has no end position`)
  return node.end
}

export function line(node: Node): number {
  return node.loc?.start.line ?? 1
}

/** The static name of a property key, or `undefined` for a computed key. */
export function keyName(key: Expression | Identifier | PrivateName | StringLiteral | Node, computed = false): string | undefined {
  if (key.type === "Identifier" && !computed) return key.name
  if (key.type === "StringLiteral") return key.value
  return undefined
}

export function findProperty(object: ObjectExpression, name: string): ObjectProperty | undefined {
  for (const property of object.properties) {
    if (property.type === "ObjectProperty" && keyName(property.key, property.computed) === name) return property
  }
  return undefined
}

/** True when `node` is an identifier that reads a binding, not a property name or declaration key. */
export function isReference(node: Node, parent: Node | undefined): node is Identifier {
  if (node.type !== "Identifier" || !parent) return false
  if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.property === node && !parent.computed) return false
  if ((parent.type === "ObjectProperty" || parent.type === "ObjectMethod" || parent.type === "ClassProperty" || parent.type === "ClassMethod")
    && parent.key === node && !parent.computed) {
    return parent.type === "ObjectProperty" && parent.shorthand && parent.value === node
  }
  if (parent.type === "TSPropertySignature" && parent.key === node && !parent.computed) return false
  if (parent.type === "VariableDeclarator" && parent.id === node) return false
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ClassDeclaration" || parent.type === "ClassExpression") && parent.id === node) return false
  if ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression" || parent.type === "ArrowFunctionExpression") && parent.params.some(param => param === node)) return false
  if (parent.type === "ImportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false
  if (parent.type === "ExportSpecifier" && parent.exported === node) return false
  if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return false
  return true
}

/** The range that removes a list item: the node, its leading comments, one separator comma, and its line when it stands alone. */
export function listItemRemoval(code: string, node: Node): [number, number] {
  let from = Math.min(start(node), ...(node.leadingComments ?? []).map(comment => comment.start ?? start(node)))
  let to = end(node)
  let cursor = to
  while (cursor < code.length && /[ \t]/.test(code[cursor] ?? "")) cursor++
  const trailingComma = code[cursor] === ","
  if (trailingComma) to = cursor + 1
  const lineStart = code.lastIndexOf("\n", from - 1) + 1
  const ownLineBefore = /^[ \t]*$/.test(code.slice(lineStart, from))
  let lineEnd = to
  while (lineEnd < code.length && /[ \t]/.test(code[lineEnd] ?? "")) lineEnd++
  const ownLineAfter = code[lineEnd] === "\n" || lineEnd === code.length
  if (ownLineBefore && ownLineAfter) {
    return [lineStart, Math.min(lineEnd + 1, code.length)]
  }
  if (!trailingComma) {
    // The last inline item: remove the comma before it instead.
    let before = from
    while (before > 0 && /\s/.test(code[before - 1] ?? "")) before--
    if (code[before - 1] === ",") from = before - 1
  }
  else {
    while (to < code.length && /[ \t]/.test(code[to] ?? "")) to++
  }
  return [from, to]
}

/** Column indentation of the line that holds `position`. */
export function indentAt(code: string, position: number): string {
  const lineStart = code.lastIndexOf("\n", position - 1) + 1
  return /^[ \t]*/.exec(code.slice(lineStart))?.[0] ?? ""
}

export interface CodeStyle {
  quote: "\"" | "'"
  semicolons: boolean
  /** One indentation level. */
  indent: string
}

export function detectStyle(code: string, program: File): CodeStyle {
  let quote: CodeStyle["quote"] | undefined
  walk(program, (node) => {
    if (!quote && node.type === "StringLiteral") quote = code[start(node)] === "'" ? "'" : "\""
  })
  const statements = program.program.body
  const semicolons = statements.length ? statements.some(statement => code[end(statement) - 1] === ";") : false
  const indentLine = /^([ \t]+)\S/m.exec(code)
  return { quote: quote ?? "\"", semicolons, indent: indentLine?.[1]?.startsWith("\t") ? "\t" : indentLine?.[1] ?? "  " }
}

export function quoteString(value: string, style: Pick<CodeStyle, "quote">): string {
  const json = JSON.stringify(value)
  if (style.quote === "\"") return json
  return `'${json.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("'", "\\'")}'`
}
