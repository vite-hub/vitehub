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
  coverage?: InstructionCoverage
  workspace?: Record<string, unknown>
}

export interface InstructionCoverage {
  capabilities: Set<string>
  skills: Set<string>
  sources: Set<string>
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
interface ComposeInstructionState {
  context: Record<string, unknown>
  coverage?: InstructionCoverage
  workspace: Record<string, unknown>
  tripleBindings: string[]
}

const defaultImportDepth = 4
const contextPathPattern = /context(?:\.[A-Za-z_$][\w$-]*)+/
const compositionPathPattern = /^(?:context|workspace)(?:\.[A-Za-z_$][\w$-]*)+$/
const compositionBindingPattern = /\{\{(?!\{)\s*((?:context|workspace)(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}/g
const tripleBindingPattern = /\{\{\{\s*(context(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}\}/g
const tripleBindingPlaceholderPattern = /%%VITEHUB_TRIPLE_BINDING_(\d+)%%/g
const scalarBindingPattern = /\{\{(?!\{)\s*(context(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}/g
const legacyCapabilityBindingPattern = /\{\{\s*capabilities(?:\.[A-Za-z_$][\w$-]*)?\s*\}\}/
const comarkComponents = {
  Binding,
  VitehubRaw: (node: ComarkElement) => typeof node[1].value === "string" ? node[1].value : "",
}

export async function resolveInstructionImports(content: string, options: ResolveInstructionImportsOptions): Promise<string> {
  return await expandInstructionImports(normalizeConditionShorthand(content), {
    ...options,
    maxDepth: options.maxDepth ?? defaultImportDepth,
    seen: new Set([options.file]),
  })
}

export async function composeInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): Promise<string> {
  const state = { context: options.context || {}, workspace: options.workspace || {} }
  const shorthand = normalizeConditionShorthand(content)
  validateConditionalDirectives(shorthand)
  const imported = await expandWorkspaceInstructionImports(shorthand, state.workspace)
  validateConditionalDirectives(imported)
  const normalized = await normalizeTripleBindings(imported)
  const tree = await parseInstructionMarkdown(normalized.content, true)
  const nodes = await composeNodes(tree.nodes, { ...state, coverage: options.coverage, tripleBindings: normalized.tripleBindings })
  return cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components: comarkComponents }))
}

export function composeStaticInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): string {
  const context = options.context || {}
  const normalized = normalizeConditionShorthand(content)
  validateConditionalDirectives(normalized)
  return stripInstructionCoverageDirectives(renderStaticContextBindings(renderStaticConditionals(normalized, context), context)).trim().replace(/\n{3,}/g, "\n\n")
}

export function createInstructionCoverage(): InstructionCoverage {
  return {
    capabilities: new Set(),
    skills: new Set(),
    sources: new Set(),
  }
}

async function parseInstructionMarkdown(content: string, bindings = false) {
  return await parse(content, {
    autoClose: false,
    autoUnwrap: false,
    html: true,
    linkify: false,
    plugins: bindings ? [binding()] : [],
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
  for (const node of nodes) expanded.push(...await expandImportNode(node, options, depth))
  return expanded
}

async function expandImportNode(
  node: ComarkNode,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): Promise<ComarkNode[]> {
  if (typeof node === "string") return await replaceImportsInText(node, options, depth)
  if (!isElement(node)) return [node]

  const [tag, attrs, ...children] = node
  if (tag === "code") return [node]
  return [[tag, attrs, ...(await expandImportNodes(children, options, depth))] as ComarkElement]
}

async function replaceImportsInText(
  text: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, seen: Set<string> },
  depth: number,
): Promise<ComarkNode[]> {
  const nodes: ComarkNode[] = []
  let textNode = ""
  let index = 0
  for (const match of text.matchAll(/@[^\s<>{}\[\]]+/g)) {
    textNode += text.slice(index, match.index)
    const token = match[0]
    const replacement = await importReplacement(token, options, depth)
    if (replacement === undefined) {
      textNode += token
    }
    else {
      if (textNode) nodes.push(textNode)
      nodes.push(rawMarkdownNode(replacement))
      textNode = ""
    }
    index = match.index + token.length
  }
  textNode += text.slice(index)
  if (textNode) nodes.push(textNode)
  return nodes
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
  for (const node of nodes) expanded.push(...await expandWorkspaceImportNode(node, workspace, depth, seen))
  return expanded
}

async function expandWorkspaceImportNode(
  node: ComarkNode,
  workspace: Record<string, unknown>,
  depth: number,
  seen: Set<string>,
): Promise<ComarkNode[]> {
  if (typeof node === "string") return await replaceWorkspaceImportsInText(node, workspace, depth, seen)
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
): Promise<ComarkNode[]> {
  const nodes: ComarkNode[] = []
  let index = 0
  for (const match of text.matchAll(/@workspace(?:\.[A-Za-z_$][\w$-]*)+/g)) {
    const before = text.slice(index, match.index)
    if (before) nodes.push(before)
    const token = match[0]
    nodes.push(rawMarkdownNode(await workspaceImportReplacement(token, workspace, depth, seen)))
    index = match.index + token.length
  }
  const after = text.slice(index)
  if (after) nodes.push(after)
  return nodes
}

function rawMarkdownNode(value: string): ComarkElement {
  return ["vitehub-raw", { value }]
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

async function normalizeTripleBindings(content: string): Promise<{ content: string, tripleBindings: string[] }> {
  const tripleBindings: string[] = []
  const tree = await parseInstructionMarkdown(content)
  const nodes = replaceTextOutsideCode(tree.nodes, value =>
    value.replace(tripleBindingPattern, (_match, path: string) => {
      const index = tripleBindings.push(path) - 1
      return `%%VITEHUB_TRIPLE_BINDING_${index}%%`
    }))
  return {
    content: await renderMarkdown({ ...tree, nodes }, { components: comarkComponents }),
    tripleBindings,
  }
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
  state: ComposeInstructionState,
  parent?: string,
): Promise<ComarkNode[]> {
  return (await Promise.all(nodes.map(node => composeNode(node, state, parent)))).flat()
}

async function composeNode(
  node: ComarkNode,
  state: ComposeInstructionState,
  parent?: string,
): Promise<ComarkNode[]> {
  if (typeof node === "string") return await composeTextNode(node, state, parent)
  if (!isElement(node)) return [node]
  const [tag, attrs, ...children] = node

  if (tag === "code") return [node]
  if (isHtmlElementAttributes(attrs)) {
    return [[tag, composeHtmlAttributes(attrs, state), ...(await composeNodes(children, state, tag))] as ComarkElement]
  }
  if (tag === "if") return await composeIfNode(node, state)
  if (tag === "else" || tag === "else-if") {
    throw new Error(`[vitehub] Instruction ${tag} block must follow an if block.`)
  }
  if (tag === "binding") return [renderBinding(attrs, state)]
  if (isInstructionCoverageTag(tag)) {
    recordInstructionCoverage(tag, attrs, state.coverage)
    return await composeNodes(children, state, parent)
  }
  if (tag === "vitehubTriple" || tag === "vitehub-triple") {
    return await renderTripleBinding(attrs, state.context, parent)
  }
  if (tag === "p") {
    const path = soleTripleBindingPath(children, state.tripleBindings)
    // ponytail: Parse standalone bindings as Markdown once without recursively composing their template syntax.
    if (path) return await renderTripleBindingPath(path, state.context)
  }
  return [[tag, composeHtmlAttributes(attrs, state), ...(await composeNodes(children, state, tag))] as ComarkElement]
}

async function composeTextNode(
  value: string,
  state: ComposeInstructionState,
  parent?: string,
): Promise<ComarkNode[]> {
  rejectLegacyCapabilityBinding(value)
  const nodes: ComarkNode[] = []
  let index = 0
  for (const match of value.matchAll(tripleBindingPlaceholderPattern)) {
    nodes.push(value.slice(index, match.index))
    const path = state.tripleBindings[Number(match[1])]
    nodes.push(...(path ? await renderTripleBindingPath(path, state.context, parent) : [match[0]]))
    index = match.index + match[0].length
  }
  nodes.push(value.slice(index))
  return nodes.filter(node => node !== "")
}

function renderBinding(
  attrs: Record<string, unknown>,
  scopes: { context: Record<string, unknown>, workspace: Record<string, unknown> },
): ComarkNode {
  const path = attrs[":value"]
  if (typeof path === "string" && (path === "capabilities" || path.startsWith("capabilities."))) {
    throw new Error(`[vitehub] Instruction binding "{{ ${path} }}" is no longer supported. Cover Capabilities with ::capability blocks in Agent Driver Instructions.`)
  }
  if (typeof path !== "string" || !compositionPathPattern.test(path)) return ["binding", attrs]
  if (path === "workspace.sources") {
    throw new Error("[vitehub] Instruction binding \"{{ workspace.sources }}\" is no longer supported. Cover Sources with ::source blocks in Agent Driver Instructions.")
  }
  return renderScalarBinding(path, scopes)
}

function renderScalarBinding(
  path: string,
  scopes: { context: Record<string, unknown>, workspace: Record<string, unknown> },
): string {
  const value = namespacePathValue(path.startsWith("workspace.") ? scopes.workspace : scopes.context, path)
  if (value === null || value === undefined) {
    throw new Error(`[vitehub] Instruction binding "{{ ${path} }}" is not defined.`)
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  throw new TypeError(`[vitehub] Instruction binding "{{ ${path} }}" must resolve to a scalar value.`)
}

function composeHtmlAttributes(
  attrs: Record<string, unknown>,
  state: Pick<ComposeInstructionState, "context" | "workspace">,
): Record<string, unknown> {
  if (!isHtmlElementAttributes(attrs)) return attrs
  return Object.fromEntries(Object.entries(attrs).map(([name, value]) => [
    name,
    typeof value === "string"
      ? value.replace(compositionBindingPattern, (_match, path: string) => escapeHtmlAttribute(renderScalarBinding(path, state)))
      : value,
  ]))
}

function isHtmlElementAttributes(attrs: Record<string, unknown>): boolean {
  return (attrs.$ as { html?: unknown } | undefined)?.html === 1
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function rejectLegacyCapabilityBinding(value: string): void {
  const match = value.match(legacyCapabilityBindingPattern)
  if (!match) return
  throw new Error(`[vitehub] Instruction binding "${match[0]}" is no longer supported. Cover Capabilities with ::capability blocks in Agent Driver Instructions.`)
}

function isInstructionCoverageTag(tag: string): tag is "capability" | "skill" | "source" {
  return tag === "capability" || tag === "skill" || tag === "source"
}

function coverageAttribute(attrs: Record<string, unknown>, tag: "capability" | "skill" | "source"): string {
  const value = tag === "skill" ? attrs.path : attrs.key
  const name = tag === "skill" ? "path" : "key"
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`[vitehub] Instruction ${tag} block requires a non-empty ${name}.`)
  }
  return value.trim()
}

function recordInstructionCoverage(
  tag: "capability" | "skill" | "source",
  attrs: Record<string, unknown>,
  coverage: InstructionCoverage | undefined,
) {
  const value = coverageAttribute(attrs, tag)
  if (!coverage) return
  if (tag === "capability") coverage.capabilities.add(value)
  if (tag === "skill") coverage.skills.add(value)
  if (tag === "source") coverage.sources.add(value)
}

function stripInstructionCoverageDirectives(content: string): string {
  let depth = 0
  const lines: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*::(?:capability|skill|source)\{/.test(line)) {
      depth += 1
      continue
    }
    if (depth > 0 && /^\s*::\s*$/.test(line)) {
      depth -= 1
      continue
    }
    lines.push(line)
  }
  return lines.join("\n")
}

async function renderTripleBinding(
  attrs: Record<string, unknown>,
  context: Record<string, unknown>,
  parent?: string,
): Promise<ComarkNode[]> {
  const path = attrs.path
  if (typeof path !== "string" || !path.startsWith("context.")) return []
  return await renderTripleBindingPath(path, context, parent)
}

async function renderTripleBindingPath(
  path: string,
  context: Record<string, unknown>,
  parent?: string,
): Promise<ComarkNode[]> {
  const value = namespacePathValue(context, path)
  if (value === null || value === undefined) {
    throw new Error(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" is not defined.`)
  }
  if (typeof value !== "string") {
    throw new TypeError(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" must resolve to a string.`)
  }
  if (parent === "p") return [rawMarkdownNode(value)]
  const nodes = (await parseInstructionMarkdown(value)).nodes
  return nodes
}

function soleTripleBindingPath(children: ComarkNode[], bindings: string[]): string | undefined {
  if (children.length !== 1 || typeof children[0] !== "string") return
  const match = children[0].match(/^%%VITEHUB_TRIPLE_BINDING_(\d+)%%$/)
  return match ? bindings[Number(match[1])] : undefined
}

async function composeIfNode(node: ComarkElement, state: ComposeInstructionState): Promise<ComarkNode[]> {
  const { after, branches } = conditionalBranches(node)
  const selected = branches.find(branch =>
    branch.expression === undefined || evaluateCondition(branch.expression, state.context))
  return [
    ...(selected ? await composeNodes(selected.nodes, state) : []),
    ...await composeNodes(after, state),
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
    if (tag === "else" && nextIndex !== -1) {
      throw new Error("[vitehub] Instruction else block cannot be followed by another branch.")
    }
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

function validateConditionalDirectives(content: string): void {
  const stack: Array<{ sawElse: boolean }> = []
  let fenced: string | undefined

  for (const line of content.split(/\r?\n/)) {
    const fence = line.match(/^\s*(```|~~~)/)?.[1]
    if (fence) {
      fenced = fenced === fence ? undefined : fence
      continue
    }
    if (fenced) continue
    if (/^\s*::\s*$/.test(line)) {
      stack.pop()
      continue
    }

    const directive = directiveLine(line)
    if (!directive) continue
    if (directive.kind === "if") {
      stack.push({ sawElse: false })
      continue
    }

    const current = stack.at(-1)
    if (!current) {
      throw new Error(`[vitehub] Instruction ${directive.kind} block must follow an if block.`)
    }
    if (directive.kind === "else-if") {
      if (current.sawElse) throw new Error("[vitehub] Instruction else-if block cannot follow else.")
      continue
    }
    if (directive.raw?.trim()) {
      throw new Error("[vitehub] Instruction else block does not accept a condition.")
    }
    if (current.sawElse) throw new Error("[vitehub] Instruction if chain cannot contain more than one else block.")
    current.sawElse = true
  }

  if (stack.length) throw new Error("[vitehub] Instruction if block is missing a closing :: line.")
}

function renderStaticConditionals(content: string, context: Record<string, unknown>): string {
  const lines = content.split(/\r?\n/)
  const rendered: string[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!
    const directive = directiveLine(line)
    if (directive?.kind === "if") {
      const result = renderStaticIfChain(lines, index, directive.expression, context)
      rendered.push(result.content)
      index = result.next
      continue
    }
    if (directive?.kind === "else" || directive?.kind === "else-if") {
      throw new Error(`[vitehub] Instruction ${directive.kind} block must follow an if block.`)
    }
    rendered.push(line)
    index += 1
  }
  return rendered.join("\n")
}

function renderStaticIfChain(
  lines: string[],
  start: number,
  expression: string | undefined,
  context: Record<string, unknown>,
): { content: string, next: number } {
  const branches: Array<{ expression?: string, lines: string[] }> = [{ expression, lines: [] }]
  let depth = 0
  let sawElse = false

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const directive = directiveLine(line)

    if (directive?.kind === "if") {
      depth += 1
      branches.at(-1)!.lines.push(line)
      continue
    }
    if (isDirectiveClose(line)) {
      if (depth > 0) {
        depth -= 1
        branches.at(-1)!.lines.push(line)
        continue
      }
      const selected = branches.find(branch =>
        branch.expression === undefined || evaluateCondition(branch.expression, context))
      return {
        content: selected ? renderStaticConditionals(selected.lines.join("\n"), context) : "",
        next: index + 1,
      }
    }
    if (depth === 0 && directive?.kind === "else-if") {
      if (sawElse) throw new Error("[vitehub] Instruction else-if block cannot follow else.")
      branches.push({ expression: directive.expression, lines: [] })
      continue
    }
    if (depth === 0 && directive?.kind === "else") {
      if (sawElse) throw new Error("[vitehub] Instruction if chain cannot contain more than one else block.")
      sawElse = true
      branches.push({ lines: [] })
      continue
    }
    branches.at(-1)!.lines.push(line)
  }

  throw new Error("[vitehub] Instruction if block is missing a closing :: line.")
}

function directiveLine(line: string): { expression?: string, kind: "else" | "else-if" | "if", raw?: string } | undefined {
  const match = line.match(/^\s*::(if|else-if|else)(?:\{(.+)\})?\s*$/)
  if (!match) return
  const kind = match[1] as "else" | "else-if" | "if"
  if (kind === "else") {
    if (match[2]?.trim()) throw new Error("[vitehub] Instruction else block does not accept a condition.")
    return { kind, raw: match[2] }
  }
  const expression = conditionExpression(match[2])
  if (!expression) throw new Error(`[vitehub] Instruction ${kind} block requires a condition.`)
  return { expression, kind, raw: match[2] }
}

function isDirectiveClose(line: string): boolean {
  return /^\s*::\s*$/.test(line)
}

function conditionExpression(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return
  const attr = value.match(/^(?:if|condition)\s*=\s*(["'])([\s\S]*)\1$/)
  return (attr ? attr[2] : value).trim()
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

function renderStaticContextBindings(content: string, context: Record<string, unknown>): string {
  return content
    .replace(tripleBindingPattern, (_match, path: string) => {
      const value = namespacePathValue(context, path)
      if (value === null || value === undefined) return ""
      if (typeof value !== "string") {
        throw new TypeError(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" must resolve to a string.`)
      }
      return value
    })
    .replace(scalarBindingPattern, (_match, path: string) => {
      const value = namespacePathValue(context, path)
      if (value === null || value === undefined) return ""
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
      throw new TypeError(`[vitehub] Instruction binding "{{ ${path} }}" must resolve to a scalar value.`)
    })
}
