import MagicString from "magic-string"

import { detectStyle, end, indentAt, keyName, line, listItemRemoval, parseProgram, quoteString, start, walk } from "./ast.ts"

import type { ArrayExpression, CallExpression, Expression, File, ObjectExpression, ObjectMethod, ObjectProperty, SpreadElement } from "@babel/types"
import type { CodeStyle, Node } from "./ast.ts"

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type ConfigForm = "vite-call" | "nuxt-module-tuple" | "nuxt-config-key"
export type ManualReason = "parse-error" | "no-vitehub" | "multiple-vitehub" | "dynamic-options" | "spread" | "computed-key"
export type ConfigValue = { kind: "literal", value: JsonValue } | { kind: "expression", source: string, line: number }
export interface ViteHubConfigSite {
  form: ConfigForm
  /** Byte range of the options object. Absent when the call or tuple has no options. */
  options?: { start: number, end: number }
  keys: Readonly<Record<string, ConfigValue>>
  /** True when a spread can supply keys that are not in `keys`. */
  spread: boolean
}
export type LocateResult = { ok: true, site: ViteHubConfigSite } | { ok: false, reason: ManualReason, line?: number }
export type ConfigEdit = { op: "set", key: string, value: JsonValue } | { op: "delete", key: string }
export type EditResult = { ok: true, code: string } | { ok: false, reason: ManualReason, line?: number }

type Member = ObjectProperty | ObjectMethod | SpreadElement
type Failure = { ok: false, reason: ManualReason, line?: number }

/** Where the options live, so an edit can add or remove them. */
type Container =
  | { kind: "call", node: CallExpression }
  | { kind: "tuple", node: ArrayExpression, head: Node }
  | { kind: "bare", node: Node }
  | { kind: "key" }

interface Located {
  site: ViteHubConfigSite
  object?: ObjectExpression
  container: Container
  program: File
  /** Nuxt's top-level defaults, below the module tuple's options. */
  defaults?: Located
}

const viteModule = "vite-hub"
const nuxtModule = "vite-hub/nuxt"

function fail(reason: ManualReason, at?: Node | number): Failure {
  if (at === undefined) return { ok: false, reason }
  return { ok: false, reason, line: typeof at === "number" ? at : line(at) }
}

function isNuxtFile(file: string): boolean {
  return /(?:^|[/\\])nuxt\.config\.[cm]?[jt]s$/.test(file)
}

function importedNames(program: File, source: string, accept: (imported: string | undefined) => boolean): Set<string> {
  const names = new Set<string>()
  for (const statement of program.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== source || statement.importKind === "type") continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") continue
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue
      const imported = specifier.type === "ImportDefaultSpecifier"
        ? undefined
        : specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value
      if (accept(imported)) names.add(specifier.local.name)
    }
  }
  return names
}

/** The default export, following an identifier to its top-level `const`. */
function defaultExport(program: File): Node | undefined {
  const exported = program.program.body.find(statement => statement.type === "ExportDefaultDeclaration")
  const declaration = exported?.type === "ExportDefaultDeclaration" ? exported.declaration : undefined
  if (declaration?.type !== "Identifier") return declaration
  for (const statement of program.program.body) {
    const variables = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (variables?.type !== "VariableDeclaration") continue
    for (const declarator of variables.declarations) {
      if (declarator.id.type === "Identifier" && declarator.id.name === declaration.name && declarator.init) return declarator.init
    }
  }
  return declaration
}

function unwrap(node: Node): Node {
  let current = node
  while (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression" || current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression
  }
  return current
}

function literalOf(node: Node): { value: JsonValue } | undefined {
  switch (node.type) {
    case "NullLiteral": return { value: null }
    case "BooleanLiteral":
    case "StringLiteral": return { value: node.value }
    case "NumericLiteral": return { value: node.value }
    case "TemplateLiteral": {
      const quasi = node.quasis[0]
      return node.expressions.length === 0 && quasi?.value.cooked != null ? { value: quasi.value.cooked } : undefined
    }
    case "UnaryExpression":
      if (node.operator === "-" && node.argument.type === "NumericLiteral") return { value: -node.argument.value }
      return undefined
    case "ArrayExpression": {
      const items: JsonValue[] = []
      for (const element of node.elements) {
        const item = element && element.type !== "SpreadElement" ? literalOf(element) : undefined
        if (!item) return undefined
        items.push(item.value)
      }
      return { value: items }
    }
    case "ObjectExpression": {
      const object: Record<string, JsonValue> = {}
      for (const property of node.properties) {
        if (property.type !== "ObjectProperty" || property.shorthand) return undefined
        const key = keyName(property.key, property.computed)
        const value = literalOf(property.value)
        if (key === undefined || key === "__proto__" || !value) return undefined
        object[key] = value.value
      }
      return { value: object }
    }
    default: return undefined
  }
}

function readKeys(code: string, object: Pick<ObjectExpression, "properties">): { keys: Record<string, ConfigValue>, spread: boolean } | Failure {
  const keys: Record<string, ConfigValue> = {}
  let spread = false
  for (const member of object.properties) {
    if (member.type === "SpreadElement") {
      spread = true
      for (const key of Object.keys(keys)) keys[key] = { kind: "expression", source: code.slice(start(member), end(member)), line: line(member) }
      continue
    }
    const key = keyName(member.key, member.computed)
    if (key === undefined) return fail("computed-key", member)
    const value = member.type === "ObjectProperty" && !member.shorthand ? member.value : member
    const literal = member.type === "ObjectProperty" && !member.shorthand ? literalOf(member.value) : undefined
    keys[key] = literal
      ? { kind: "literal", value: literal.value }
      : { kind: "expression", source: code.slice(start(value), end(value)), line: line(value) }
  }
  return { keys, spread }
}

function siteFor(code: string, form: ConfigForm, options: Node | undefined, container: Container, program: File): Located | Failure {
  if (!options) return { site: { form, keys: {}, spread: false }, container, program }
  const object = unwrap(options)
  if (object.type !== "ObjectExpression") return fail("dynamic-options", options)
  const read = readKeys(code, object)
  if ("ok" in read) return read
  return { site: { form, options: { start: start(object), end: end(object) }, keys: read.keys, spread: read.spread }, object, container, program }
}

function locateVite(code: string, program: File): Located | Failure {
  const names = importedNames(program, viteModule, imported => imported === undefined || imported === "vitehub")
  const root = defaultExport(program)
  if (!names.size || !root) return fail("no-vitehub")
  const calls: Array<CallExpression> = []
  walk(root, (node) => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && names.has(node.callee.name)) calls.push(node)
  })
  const [call, second] = calls
  if (!call) {
    // A call outside the export may reach it through a binding. Do not claim it is absent.
    let factored: CallExpression | undefined
    walk(program, (node) => {
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && names.has(node.callee.name)) factored = node
    })
    return factored ? fail("dynamic-options", factored) : fail("no-vitehub")
  }
  if (second) return fail("multiple-vitehub", second)
  const argument = call.arguments[0]
  if (argument && (argument.type === "SpreadElement" || argument.type === "ArgumentPlaceholder")) return fail("dynamic-options", argument)
  return siteFor(code, "vite-call", argument, { kind: "call", node: call }, program)
}

function findMember(object: ObjectExpression, name: string): ObjectProperty | undefined {
  let found: ObjectProperty | undefined
  for (const member of object.properties) {
    if (member.type === "ObjectProperty" && keyName(member.key, member.computed) === name) found = member
  }
  return found
}

function locateNuxt(code: string, program: File): Located | Failure {
  const names = importedNames(program, nuxtModule, () => true)
  let mentioned = names.size > 0
  walk(program, (node) => {
    if (node.type === "StringLiteral" && node.value === nuxtModule) mentioned = true
  })
  if (!mentioned) return fail("no-vitehub")
  const exported = defaultExport(program)
  if (!exported) return fail("no-vitehub")
  let root = unwrap(exported)
  if (root.type === "CallExpression" && root.arguments[0]) root = unwrap(root.arguments[0])
  if (root.type !== "ObjectExpression") return fail("dynamic-options", root)
  const modulesProperty = findMember(root, "modules")
  if (!modulesProperty) return fail("no-vitehub")
  const modules = unwrap(modulesProperty.value)
  if (modules.type !== "ArrayExpression") return fail("dynamic-options", modules)
  const isHead = (node: Node | null | undefined) => Boolean(node && ((node.type === "StringLiteral" && node.value === nuxtModule) || (node.type === "Identifier" && names.has(node.name))))
  const entries = modules.elements.filter((element): element is Expression => {
    if (!element || element.type === "SpreadElement") return false
    return element.type === "ArrayExpression" ? isHead(element.elements[0]) : isHead(element)
  })
  const [entry, second] = entries
  if (!entry) return fail("no-vitehub")
  if (second) return fail("multiple-vitehub", second)
  const keyProperty = findMember(root, "vitehub")
  const tupleOptions = entry.type === "ArrayExpression" ? entry.elements[1] : undefined
  if (tupleOptions && tupleOptions.type === "SpreadElement") return fail("dynamic-options", tupleOptions)
  if (keyProperty && !tupleOptions) return siteFor(code, "nuxt-config-key", keyProperty.value, { kind: "key" }, program)
  const container: Container = entry.type === "ArrayExpression"
    ? { kind: "tuple", node: entry, head: entry.elements[0] ?? entry }
    : { kind: "bare", node: entry }
  const located = siteFor(code, "nuxt-module-tuple", tupleOptions ?? undefined, container, program)
  if ("ok" in located || !keyProperty) return located
  const defaults = siteFor(code, "nuxt-config-key", keyProperty.value, { kind: "key" }, program)
  if ("ok" in defaults) return defaults
  // The runtime shallowly merges top-level options first, then the tuple options.
  const merged = readKeys(code, { properties: [...(defaults.object?.properties ?? []), ...(located.object?.properties ?? [])] })
  if ("ok" in merged) return merged
  return { ...located, defaults, site: { ...located.site, ...merged } }
}

function parse(code: string): File | Failure {
  try {
    return parseProgram(code)
  }
  catch (error) {
    const at = typeof error === "object" && error !== null && "loc" in error && typeof error.loc === "object" && error.loc !== null
      && "line" in error.loc && typeof error.loc.line === "number"
      ? error.loc.line
      : undefined
    return fail("parse-error", at)
  }
}

function locate(file: string, code: string): Located | Failure {
  const program = parse(code)
  if ("ok" in program) return program
  return isNuxtFile(file) ? locateNuxt(code, program) : locateVite(code, program)
}

/** Finds the ViteHub options in a `vite.config` or `nuxt.config` file without evaluating it. */
export function locateViteHubConfig(file: string, code: string): LocateResult {
  const located = locate(file, code)
  return "ok" in located ? located : { ok: true, site: located.site }
}

function propertyKey(name: string, style: CodeStyle): string {
  if (name === "__proto__") return `[${quoteString(name, style)}]`
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : quoteString(name, style)
}

function serialize(value: JsonValue, style: CodeStyle): string {
  if (value === null) return "null"
  if (typeof value === "string") return quoteString(value, style)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot write ${value} to a config file.`)
    return Object.is(value, -0) ? "0" : String(value)
  }
  if (typeof value === "boolean") return String(value)
  if (isArray(value)) return `[${value.map(item => serialize(item, style)).join(", ")}]`
  const entries = Object.entries(value)
  if (!entries.length) return "{}"
  return `{ ${entries.map(([key, item]) => `${propertyKey(key, style)}: ${serialize(item, style)}`).join(", ")} }`
}

function isArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function lineBreakAfter(code: string, position: number): number {
  const index = code.indexOf("\n", position)
  if (index === -1) return code.length
  return code[index - 1] === "\r" ? index - 1 : index
}

function skipBlanks(code: string, position: number): number {
  let cursor = position
  while (cursor < code.length && /[ \t]/.test(code[cursor] ?? "")) cursor++
  return cursor
}

/** Adds `text` (a `key: value` pair) as the last member of `object`, copying the sibling layout. */
function appendMember(output: MagicString, code: string, object: ObjectExpression, text: string, style: CodeStyle): void {
  const closing = end(object) - 1
  const last = object.properties.at(-1)
  if (!last) {
    const inner = code.slice(start(object) + 1, closing)
    if (/^\s*$/.test(inner)) output.overwrite(start(object) + 1, closing, ` ${text} `)
    else output.appendLeft(start(object) + 1, ` ${text},`)
    return
  }
  const afterLast = skipBlanks(code, end(last))
  const trailing = code[afterLast] === ","
  const afterComma = trailing ? afterLast + 1 : end(last)
  const lineBreak = lineBreakAfter(code, afterComma)
  if (lineBreak >= closing) {
    // The closing brace shares the line with the last member.
    output.appendLeft(afterComma, trailing ? ` ${text},` : `, ${text}`)
    return
  }
  const newline = code.includes("\r\n") ? "\r\n" : "\n"
  if (!trailing) output.appendLeft(end(last), ",")
  output.appendLeft(lineBreak, `${newline}${indentAt(code, start(last)) || style.indent}${text}${trailing ? "," : ""}`)
}

/** Removes `member` from `object`, with the separator that the append added. */
function removeMember(output: MagicString, code: string, object: ObjectExpression, member: Member): void {
  const index = object.properties.indexOf(member)
  const previous = index > 0 ? object.properties[index - 1] : undefined
  // A comment on the line of the previous member belongs to that member.
  const own = previous
    ? { ...member, leadingComments: (member.leadingComments ?? []).filter(comment => (comment.start ?? 0) > lineBreakAfter(code, end(previous))) }
    : member
  const [from, to] = listItemRemoval(code, own)
  output.remove(from, to)
  const isLast = index === object.properties.length - 1
  // listItemRemoval takes the comma before an inline last member, but not before a last member on its own line.
  if (isLast && previous && code[from] !== "," && code[skipBlanks(code, end(member))] !== ",") {
    const comma = skipBlanks(code, end(previous))
    if (code[comma] === ",") output.remove(comma, comma + 1)
  }
}

function sameValue(left: ConfigValue | undefined, right: ConfigValue | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false
  if (left.kind === "expression" && right.kind === "expression") return left.source === right.source
  return left.kind === "literal" && right.kind === "literal" && JSON.stringify(left.value) === JSON.stringify(right.value)
}

function sameKeys(actual: Readonly<Record<string, ConfigValue>>, expected: Readonly<Record<string, ConfigValue>>): boolean {
  const names = Object.keys(expected)
  if (Object.keys(actual).length !== names.length) return false
  return names.every(name => sameValue(actual[name], expected[name]))
}

function applyEdit(code: string, located: Located, edit: ConfigEdit): string | Failure {
  const { site, object, container } = located
  const style = detectStyle(code, located.program)
  const output = new MagicString(code)
  const members = object?.properties ?? []
  const matches = members.filter((member): member is ObjectProperty | ObjectMethod => member.type !== "SpreadElement" && keyName(member.key, member.computed) === edit.key)

  if (edit.op === "delete") {
    const lastMatch = matches.at(-1)
    if (lastMatch && members.slice(members.indexOf(lastMatch) + 1).some(member => member.type === "SpreadElement")) return fail("spread", object)
    if (!matches.length) {
      if (site.spread) return fail("spread", object)
      return code
    }
    if (!object) return code
    if (matches.length === members.length) {
      if (container.kind === "call") {
        const argument = container.node.arguments[0]
        const next = container.node.arguments[1]
        if (argument) output.remove(start(argument), next ? start(next) : end(container.node) - 1)
      }
      else if (container.kind === "tuple") {
        output.overwrite(start(container.node), end(container.node), code.slice(start(container.head), end(container.head)))
      }
      else {
        output.remove(start(object) + 1, end(object) - 1)
      }
      return output.toString()
    }
    for (const match of matches) removeMember(output, code, object, match)
    return output.toString()
  }

  const text = `${propertyKey(edit.key, style)}: ${serialize(edit.value, style)}`
  if (!object) {
    if (container.kind === "call") output.appendLeft(end(container.node) - 1, `{ ${text} }`)
    else if (container.kind === "tuple") output.appendLeft(end(container.head), `, { ${text} }`)
    else if (container.kind === "bare") output.overwrite(start(container.node), end(container.node), `[${code.slice(start(container.node), end(container.node))}, { ${text} }]`)
    return output.toString()
  }
  const match = matches.at(-1)
  const lastSpread = members.findLastIndex(member => member.type === "SpreadElement")
  if (match && members.indexOf(match) > lastSpread) {
    if (match.type === "ObjectProperty" && !match.shorthand) output.overwrite(start(match.value), end(match.value), serialize(edit.value, style))
    else output.overwrite(start(match), end(match), text)
    return output.toString()
  }
  // A spread after the key can override it, so the key moves after the spread.
  for (const old of matches) removeMember(output, code, object, old)
  appendMember(output, code, object, text, style)
  return output.toString()
}

/** Sets or deletes top-level ViteHub options. Edits only the options and keeps the rest of the file byte for byte. */
export function editViteHubConfig(file: string, code: string, edits: readonly ConfigEdit[]): EditResult {
  let current = code
  for (const edit of edits) {
    let located = locate(file, current)
    if ("ok" in located) return located
    const expected: Record<string, ConfigValue> = { ...located.site.keys }
    if (edit.op === "set") expected[edit.key] = { kind: "literal", value: edit.value }
    else delete expected[edit.key]
    if (edit.op === "delete" && located.defaults) {
      const next = applyEdit(current, located.defaults, edit)
      if (typeof next !== "string") return next
      current = next
      located = locate(file, current)
      if ("ok" in located) return located
    }
    const next = applyEdit(current, located, edit)
    if (typeof next !== "string") return next
    const after = locate(file, next)
    if ("ok" in after || !sameKeys(after.site.keys, expected)) return fail("parse-error")
    current = next
  }
  return { ok: true, code: current }
}
