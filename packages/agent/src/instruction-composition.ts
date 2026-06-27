import { parse } from "comark"
import binding, { Binding } from "comark/plugins/binding"
import { renderMarkdown } from "comark/render"

export interface InstructionImportResolution {
  content: string
  file: string
}

export interface ResolveInstructionImportsOptions {
  file: string
  maxDepth?: number
  read: (specifier: string, importer: string) => InstructionImportResolution
}

export interface ComposeInstructionDocumentOptions {
  context?: Record<string, unknown>
  workspace?: Record<string, unknown>
}

type ConditionOperator = "!" | "!=" | "!==" | "&&" | "(" | ")" | "==" | "===" | "||"
type ConditionToken =
  | { type: "literal", value: unknown }
  | { type: "op", value: ConditionOperator }
  | { path: string, type: "path" }
type ComarkElementAttributes = Record<string, unknown>
type ComarkElement = [string, ComarkElementAttributes, ...ComarkNode[]]
type ComarkComment = [null, ComarkElementAttributes, string]
type ComarkNode = ComarkComment | ComarkElement | string

const defaultImportDepth = 4
const contextPathPattern = /context(?:\.[A-Za-z_$][\w$-]*)+/
const compositionPathPattern = /^(?:context|workspace)(?:\.[A-Za-z_$][\w$-]*)+$/
const tripleBindingPattern = /\{\{\{\s*(context(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}\}/g
const comarkComponents = { Binding }
const noLinkify = {
  markdownItPlugins: [(md: { disable: (rule: string) => unknown, set: (options: Record<string, unknown>) => unknown }) => {
    md.disable("linkify")
    md.set({ linkify: false })
  }],
  name: "vitehub-no-linkify",
}

export async function resolveInstructionImports(content: string, options: ResolveInstructionImportsOptions): Promise<string> {
  return await expandInstructionImports(normalizeConditionShorthand(content), {
    ...options,
    maxDepth: options.maxDepth ?? defaultImportDepth,
    seen: new Set([options.file]),
  })
}

export async function composeInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): Promise<string> {
  const scopes = { context: options.context || {}, workspace: options.workspace || {} }
  const imported = await expandWorkspaceInstructionImports(normalizeConditionShorthand(content), scopes.workspace)
  const normalized = await normalizeTripleBindings(imported)
  const tree = await parseInstructionMarkdown(normalized, true)
  const nodes = await composeNodes(tree.nodes, scopes)
  return cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components: comarkComponents }))
}

async function parseInstructionMarkdown(content: string, bindings = false) {
  return await parse(content, {
    autoClose: false,
    autoUnwrap: false,
    plugins: bindings ? [noLinkify, binding()] : [noLinkify],
  })
}

function cleanMarkdown(content: string): string {
  return content.trim().replace(/\n{3,}/g, "\n\n")
}

async function expandInstructionImports(
  content: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth = 0,
): Promise<string> {
  const tree = await parseInstructionMarkdown(content)
  const nodes = await expandImportNodes(tree.nodes, options, depth)
  const rendered = cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components: comarkComponents }))
  return content.endsWith("\n") ? `${rendered}\n` : rendered
}

async function expandImportNodes(
  nodes: ComarkNode[],
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): Promise<ComarkNode[]> {
  const expanded: ComarkNode[] = []
  for (const node of nodes) {
    expanded.push(...await expandImportNode(node, options, depth))
  }
  return expanded
}

async function expandImportNode(
  node: ComarkNode,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): Promise<ComarkNode[]> {
  if (typeof node === "string") {
    return [await replaceImportsInText(node, options, depth)]
  }
  if (!isElement(node)) return [node]

  const [tag, attrs, ...children] = node
  if (tag === "code") return [node]
  return [[tag, attrs, ...(await expandImportNodes(children, options, depth))] as ComarkElement]
}

async function replaceImportsInText(
  text: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): Promise<string> {
  let rendered = ""
  let index = 0
  for (const match of text.matchAll(/@[^\s<>{}\[\]]+/g)) {
    rendered += text.slice(index, match.index)
    const token = match[0]
    const replacement = await importReplacement(token, options, depth)
    rendered += replacement ?? token
    index = match.index + token.length
  }
  return rendered + text.slice(index)
}

async function expandWorkspaceInstructionImports(
  content: string,
  workspace: Record<string, unknown>,
  depth = 0,
  seen: Set<string> = new Set(),
): Promise<string> {
  const tree = await parseInstructionMarkdown(content)
  const nodes = await expandWorkspaceImportNodes(tree.nodes, workspace, depth, seen)
  const rendered = cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components: comarkComponents }))
  return content.endsWith("\n") ? `${rendered}\n` : rendered
}

async function expandWorkspaceImportNodes(
  nodes: ComarkNode[],
  workspace: Record<string, unknown>,
  depth: number,
  seen: Set<string>,
): Promise<ComarkNode[]> {
  const expanded: ComarkNode[] = []
  for (const node of nodes) {
    expanded.push(...await expandWorkspaceImportNode(node, workspace, depth, seen))
  }
  return expanded
}

async function expandWorkspaceImportNode(
  node: ComarkNode,
  workspace: Record<string, unknown>,
  depth: number,
  seen: Set<string>,
): Promise<ComarkNode[]> {
  if (typeof node === "string") {
    return [await replaceWorkspaceImportsInText(node, workspace, depth, seen)]
  }
  if (!isElement(node)) return [node]

  const [tag, attrs, ...children] = node
  if (tag === "code") return [node]
  return [[tag, attrs, ...(await expandWorkspaceImportNodes(children, workspace, depth, seen))] as ComarkElement]
}

async function replaceWorkspaceImportsInText(
  text: string,
  workspace: Record<string, unknown>,
  depth: number,
  seen: Set<string>,
): Promise<string> {
  let rendered = ""
  let index = 0
  for (const match of text.matchAll(/@workspace(?:\.[A-Za-z_$][\w$-]*)+/g)) {
    rendered += text.slice(index, match.index)
    const token = match[0]
    rendered += await workspaceImportReplacement(token, workspace, depth, seen)
    index = match.index + token.length
  }
  return rendered + text.slice(index)
}

async function workspaceImportReplacement(
  token: string,
  workspace: Record<string, unknown>,
  depth: number,
  seen: Set<string>,
): Promise<string> {
  if (depth >= defaultImportDepth) {
    throw new Error(`[vitehub] Instruction workspace import depth exceeded ${defaultImportDepth}.`)
  }
  const path = token.slice(1)
  const value = namespacePathValue(workspace, path)
  if (value === null || value === undefined) {
    throw new Error(`[vitehub] Instruction workspace import "${token}" is not defined.`)
  }
  if (typeof value !== "string") {
    throw new TypeError(`[vitehub] Instruction workspace import "${token}" must resolve to a string.`)
  }
  if (seen.has(path)) {
    throw new Error(`[vitehub] Circular instruction workspace import: ${token}.`)
  }
  seen.add(path)
  try {
    return await expandWorkspaceInstructionImports(normalizeConditionShorthand(value), workspace, depth + 1, seen)
  }
  finally {
    seen.delete(path)
  }
}

async function importReplacement(
  token: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): Promise<string | undefined> {
  if (/^@(?:https?:)?\/\//.test(token) || token.startsWith("@/")) {
    throw new Error(`[vitehub] Instruction import "${token}" must be a relative file path.`)
  }
  if (!token.startsWith("@./") && !token.startsWith("@../")) return undefined

  const trailing = token.match(/[.,;:!?)]*$/)?.[0] || ""
  const specifier = token.slice(1, token.length - trailing.length)
  if (/[*?]/.test(specifier)) {
    throw new Error(`[vitehub] Instruction import "${specifier}" cannot use globs.`)
  }
  if (depth >= options.maxDepth) {
    throw new Error(`[vitehub] Instruction import depth exceeded ${options.maxDepth}.`)
  }

  const resolved = options.read(specifier, options.file)
  if (options.seen.has(resolved.file)) {
    throw new Error(`[vitehub] Circular instruction import: ${specifier}.`)
  }
  options.seen.add(resolved.file)
  try {
    return `${await expandInstructionImports(normalizeConditionShorthand(resolved.content), { ...options, file: resolved.file }, depth + 1)}${trailing}`
  }
  finally {
    options.seen.delete(resolved.file)
  }
}

function normalizeConditionShorthand(content: string): string {
  let fenced: string | undefined
  return content.split(/\r?\n/).map((line) => {
    const fence = line.match(/^\s*(```|~~~)/)?.[1]
    if (fence) {
      fenced = fenced ? undefined : fence
      return line
    }
    if (fenced) return line
    return line.replace(/^(\s*::(?:if|else-if))\{([\s\S]+)\}(\s*)$/, (match, start: string, expression: string, end: string) =>
      /^(?:if|condition)\s*=/.test(expression.trim())
        ? match
        : `${start}{condition=${JSON.stringify(expression.trim())}}${end}`)
  }).join("\n")
}

async function normalizeTripleBindings(content: string): Promise<string> {
  const tree = await parseInstructionMarkdown(content)
  const nodes = replaceTextOutsideCode(tree.nodes, value =>
    value.replace(tripleBindingPattern, (_match, path: string) => `:vitehubTriple{path=${JSON.stringify(path)}}`))
  return await renderMarkdown({ ...tree, nodes }, { components: comarkComponents })
}

function replaceTextOutsideCode(nodes: ComarkNode[], replace: (value: string) => string): ComarkNode[] {
  return nodes.map((node) => {
    if (typeof node === "string") return replace(node)
    if (!isElement(node)) return node
    const [tag, attrs, ...children] = node
    if (tag === "code") return node
    return [tag, attrs, ...replaceTextOutsideCode(children, replace)] as ComarkElement
  })
}

async function composeNodes(
  nodes: ComarkNode[],
  scopes: { context: Record<string, unknown>, workspace: Record<string, unknown> },
  parent?: string,
): Promise<ComarkNode[]> {
  return (await Promise.all(nodes.map(node => composeNode(node, scopes, parent)))).flat()
}

async function composeNode(
  node: ComarkNode,
  scopes: { context: Record<string, unknown>, workspace: Record<string, unknown> },
  parent?: string,
): Promise<ComarkNode[]> {
  if (typeof node === "string" || !isElement(node)) return [node]
  const [tag, attrs, ...children] = node

  if (tag === "if") return await composeIfNode(node, scopes)
  if (tag === "else" || tag === "else-if") {
    throw new Error(`[vitehub] Instruction ${tag} block must follow an if block.`)
  }
  if (tag === "binding") return [renderBinding(attrs, scopes)]
  if (tag === "vitehubTriple" || tag === "vitehub-triple") {
    return await renderTripleBinding(attrs, scopes.context, parent)
  }
  if (tag === "code") return [node]
  return [[tag, attrs, ...(await composeNodes(children, scopes, tag))] as ComarkElement]
}

function renderBinding(
  attrs: Record<string, unknown>,
  scopes: { context: Record<string, unknown>, workspace: Record<string, unknown> },
): ComarkNode {
  const path = attrs[":value"]
  if (typeof path !== "string" || !compositionPathPattern.test(path)) return ["binding", attrs]
  if (path === "workspace.sources" && namespacePathValue(scopes.workspace, path) === undefined) return ["binding", attrs]
  const value = namespacePathValue(path.startsWith("workspace.") ? scopes.workspace : scopes.context, path)
  if (value === null || value === undefined) return ""
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  throw new TypeError(`[vitehub] Instruction binding "{{ ${path} }}" must resolve to a scalar value.`)
}

async function renderTripleBinding(
  attrs: Record<string, unknown>,
  context: Record<string, unknown>,
  parent?: string,
): Promise<ComarkNode[]> {
  const path = attrs.path
  if (typeof path !== "string" || !path.startsWith("context.")) return []
  const value = namespacePathValue(context, path)
  if (value === null || value === undefined) return []
  if (typeof value !== "string") {
    throw new TypeError(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" must resolve to a string.`)
  }
  if (parent === "p") return [value]
  return (await parseInstructionMarkdown(value)).nodes
}

async function composeIfNode(
  node: ComarkElement,
  scopes: { context: Record<string, unknown>, workspace: Record<string, unknown> },
): Promise<ComarkNode[]> {
  const { after, branches } = conditionalBranches(node)
  const selected = branches.find(branch =>
    branch.expression === undefined || evaluateCondition(branch.expression, scopes.context))
  return [
    ...(selected ? await composeNodes(selected.nodes, scopes) : []),
    ...await composeNodes(after, scopes),
  ]
}

function conditionalBranches(node: ComarkElement): { after: ComarkNode[], branches: Array<{ expression?: string, nodes: ComarkNode[] }> } {
  const branches: Array<{ expression?: string, nodes: ComarkNode[] }> = []
  let current: ComarkElement | undefined = node
  const after: ComarkNode[] = []
  while (current) {
    const [tag, attrs, ...children] = current
    if (tag === "else" && Object.keys(attrs).length) {
      throw new Error("[vitehub] Instruction else block does not accept a condition.")
    }
    const expression = tag === "else" ? undefined : conditionExpressionFromAttrs(attrs, tag)
    const nextIndex = children.findIndex(child => isElement(child) && (child[0] === "else-if" || child[0] === "else"))
    branches.push({
      expression,
      nodes: nextIndex === -1 ? children : children.slice(0, nextIndex),
    })
    if (nextIndex !== -1) after.push(...children.slice(nextIndex + 1))
    current = nextIndex === -1 ? undefined : children[nextIndex] as ComarkElement
  }
  return { after, branches }
}

function isElement(node: ComarkNode): node is ComarkElement {
  return Array.isArray(node) && typeof node[0] === "string"
}

function conditionExpressionFromAttrs(attrs: Record<string, unknown>, kind: string): string {
  const expression = attrs.condition ?? attrs.if
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error(`[vitehub] Instruction ${kind} block requires a condition.`)
  }
  return expression.trim()
}

function evaluateCondition(expression: string, context: Record<string, unknown>): boolean {
  const parser = createConditionParser(tokenizeCondition(expression), expression, context)
  const value = parser.parseOr()
  parser.done()
  return Boolean(value)
}

function tokenizeCondition(expression: string): ConditionToken[] {
  const tokens: ConditionToken[] = []
  for (let index = 0; index < expression.length;) {
    const rest = expression.slice(index)
    if (/^\s/.test(rest)) {
      index += 1
      continue
    }
    const op = rest.match(/^(===|!==|==|!=|&&|\|\||[!()])/)
    if (op) {
      tokens.push({ type: "op", value: op[1] as ConditionOperator })
      index += op[1]!.length
      continue
    }
    const path = rest.match(new RegExp(`^${contextPathPattern.source}`))
    if (path) {
      tokens.push({ path: path[0], type: "path" })
      index += path[0].length
      continue
    }
    const string = rest.match(/^(['"])((?:\\.|(?!\1)[^\\])*)\1/)
    if (string) {
      tokens.push({ type: "literal", value: string[2]!.replace(/\\(['"\\])/g, "$1") })
      index += string[0].length
      continue
    }
    const number = rest.match(/^-?\d+(?:\.\d+)?/)
    if (number) {
      tokens.push({ type: "literal", value: Number(number[0]) })
      index += number[0].length
      continue
    }
    const literal = rest.match(/^(true|false|null)\b/)
    if (literal) {
      tokens.push({ type: "literal", value: literal[1] === "true" ? true : literal[1] === "false" ? false : null })
      index += literal[0].length
      continue
    }
    throw new Error(`[vitehub] Unsafe instruction condition "${expression}". Conditions can only read context.* paths and use literals, ===, !==, &&, ||, !, and parentheses.`)
  }
  return tokens
}

function createConditionParser(tokens: ConditionToken[], expression: string, context: Record<string, unknown>) {
  let index = 0
  const error = () => new Error(`[vitehub] Invalid instruction condition "${expression}".`)
  const peek = () => tokens[index]
  const take = (value?: string) => {
    const token = tokens[index]
    if (value && (token?.type !== "op" || token.value !== value)) throw error()
    index += 1
    return token
  }

  function parsePrimary(): unknown {
    const token = take()
    if (!token) throw error()
    if (token.type === "literal") return token.value
    if (token.type === "path") return namespacePathValue(context, token.path)
    if (token.type === "op" && token.value === "(") {
      const value = parseOr()
      take(")")
      return value
    }
    throw error()
  }

  function parseUnary(): unknown {
    const token = peek()
    if (token?.type === "op" && token.value === "!") {
      take("!")
      return !Boolean(parseUnary())
    }
    return parsePrimary()
  }

  function parseEquality(): unknown {
    let value = parseUnary()
    const token = peek()
    if (token?.type === "op" && ["==", "===", "!=", "!=="].includes(token.value)) {
      take()
      const right = parseUnary()
      value = token.value === "!=" || token.value === "!==" ? value !== right : value === right
    }
    return value
  }

  function parseAnd(): unknown {
    let value = parseEquality()
    while (peek()?.type === "op" && (peek() as { value: string }).value === "&&") {
      take("&&")
      const right = parseEquality()
      value = Boolean(value) && Boolean(right)
    }
    return value
  }

  function parseOr(): unknown {
    let value = parseAnd()
    while (peek()?.type === "op" && (peek() as { value: string }).value === "||") {
      take("||")
      const right = parseAnd()
      value = Boolean(value) || Boolean(right)
    }
    return value
  }

  return {
    done() {
      if (index !== tokens.length) throw error()
    },
    parseOr,
  }
}

function namespacePathValue(context: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".").slice(1)
  for (let count = segments.length; count > 0; count -= 1) {
    const key = segments.slice(0, count).join(".")
    if (Object.hasOwn(context, key)) {
      return nestedPathValue(context[key], segments.slice(count))
    }
  }
  return nestedPathValue(context, segments)
}

function nestedPathValue(value: unknown, segments: string[]): unknown {
  let current = value
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
