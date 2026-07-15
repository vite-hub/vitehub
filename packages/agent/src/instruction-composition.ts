import { parse } from "comark"
import binding, { Binding } from "comark/plugins/binding"
import { renderMarkdown } from "comark/render"
import { renderMarkdownTemplate } from "@vite-hub/markdown-template"

import type { NodeHandler } from "comark/render"

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

interface InstructionCoverageMarker {
  entries: Array<{
    attributes: Record<string, unknown>
    kind: "capability" | "skill" | "source"
  }>
  prefix: string
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
interface InstructionMarkdownRuntime {
  components: Record<string, NodeHandler>
  rawTag: string
}

interface InstructionTemplateTags {
  prefix: string
  values: string[]
}

interface InstructionProtectedTokens {
  prefix: string
  values: string[]
}

const defaultImportDepth = 4
const contextPathPattern = /context(?:\.[A-Za-z_$][\w$-]*)+/
const tripleBindingPattern = /\{\{\{\s*(context(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}\}/g
const instructionTripleBindingPattern = /\{\{\{\s*([A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}\}/g
const scalarBindingPattern = /\{\{(?!\{)\s*(context(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}/g

export async function resolveInstructionImports(content: string, options: ResolveInstructionImportsOptions): Promise<string> {
  const runtime = createInstructionMarkdownRuntime()
  const protectedTokens = createInstructionProtectedTokens()
  const expanded = await expandInstructionImports(await normalizeDynamicConditionShorthand(content, protectedTokens), {
    ...options,
    maxDepth: options.maxDepth ?? defaultImportDepth,
    protectedTokens,
    runtime,
    seen: new Set([options.file]),
  })
  return restoreInstructionProtectedTokens(expanded, protectedTokens)
}

export async function composeInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): Promise<string> {
  const state = { context: options.context || {}, workspace: options.workspace || {} }
  const protectedTokens = createInstructionProtectedTokens()
  const shorthand = await normalizeDynamicConditionShorthand(content, protectedTokens)
  validateConditionalDirectives(await instructionDirectiveValidationSource(shorthand))
  const imported = await expandWorkspaceInstructionImports(shorthand, state.workspace, 0, new Set(), protectedTokens)
  validateConditionalDirectives(await instructionDirectiveValidationSource(imported))
  validateInstructionMarkdownBindings(imported)
  await validateLegacyInstructionBindings(imported)
  await validateInstructionConditions(imported, state.context)
  const coverageMarker = createInstructionCoverageMarker()
  const marked = await markInstructionCoverage(imported, coverageMarker)

  try {
    const rendered = await renderMarkdownTemplate(restoreInstructionProtectedTokens(marked, protectedTokens), { data: state })
    return await stripMarkedInstructionCoverage(rendered, coverageMarker, options.coverage)
  }
  catch (error) {
    rethrowInstructionCompositionError(error)
  }
}

function validateInstructionMarkdownBindings(content: string): void {
  for (const match of content.matchAll(instructionTripleBindingPattern)) {
    const path = match[1]!
    if (!path.startsWith("context.")) {
      throw new Error(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" must use a context.* path. Import Workspace Markdown with @${path}.`)
    }
  }
}

export function composeStaticInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): string {
  const context = options.context || {}
  const normalized = normalizeStaticConditionShorthand(content)
  validateConditionalDirectives(normalized)
  return stripStaticInstructionCoverageDirectives(renderStaticContextBindings(renderStaticConditionals(normalized, context), context)).trim().replace(/\n{3,}/g, "\n\n")
}

export function createInstructionCoverage(): InstructionCoverage {
  return {
    capabilities: new Set(),
    skills: new Set(),
    sources: new Set(),
  }
}

function createInstructionCoverageMarker(): InstructionCoverageMarker {
  return {
    entries: [],
    prefix: `vitehub-instruction-coverage-${crypto.randomUUID()}`,
  }
}

async function validateLegacyInstructionBindings(content: string): Promise<void> {
  const { tree } = await parseInstructionTemplate(content, true)
  validateLegacyInstructionBindingNodes(tree.nodes)
}

function validateLegacyInstructionBindingNodes(nodes: ComarkNode[]): void {
  for (const node of nodes) {
    if (!isElement(node)) continue
    const [tag, attrs, ...children] = node
    if (tag === "code") continue
    if (tag === "binding") {
      const path = attrs[":value"]
      if (typeof path === "string" && (path === "capabilities" || path.startsWith("capabilities."))) {
        throw new Error(`[vitehub] Instruction binding "{{ ${path} }}" is no longer supported. Cover Capabilities with ::capability blocks in Agent Driver Instructions.`)
      }
      if (path === "workspace.sources") {
        throw new Error("[vitehub] Instruction binding \"{{ workspace.sources }}\" is no longer supported. Cover Sources with ::source blocks in Agent Driver Instructions.")
      }
    }
    validateLegacyInstructionBindingNodes(children)
  }
}

async function validateInstructionConditions(
  content: string,
  context: Record<string, unknown>,
): Promise<void> {
  const { tree } = await parseInstructionTemplate(content)
  validateInstructionConditionNodes(tree.nodes, context)
}

function validateInstructionConditionNodes(
  nodes: ComarkNode[],
  context: Record<string, unknown>,
): void {
  for (const node of nodes) {
    if (!isElement(node)) continue
    const [tag, , ...children] = node
    if (tag === "code") continue
    if (tag === "if") {
      const { after, branches } = conditionalBranches(node)
      const selected = branches.find(branch =>
        branch.expression === undefined || evaluateCondition(branch.expression, context))
      if (selected) validateInstructionConditionNodes(selected.nodes, context)
      validateInstructionConditionNodes(after, context)
    }
    else {
      validateInstructionConditionNodes(children, context)
    }
  }
}

async function markInstructionCoverage(
  content: string,
  marker: InstructionCoverageMarker,
): Promise<string> {
  const stack: Array<{ coverage?: number }> = []
  const lines: string[] = []
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*:{2,}\s*$/.test(line)) {
      const current = stack.pop()
      lines.push(current?.coverage === undefined
        ? line
        : `<!--${coverageMarkerValue(marker, current.coverage, "end")}-->`)
      continue
    }

    const directive = line.match(/^\s*(:{2,})([A-Za-z][\w-]*)(?:\{.*\})?\s*$/)
    if (!directive || directive[2] === "else" || directive[2] === "else-if") {
      lines.push(line)
      continue
    }
    const tag = directive[2]!
    if (!isInstructionCoverageTag(tag)) {
      stack.push({})
      lines.push(line)
      continue
    }

    const attributes = await instructionDirectiveAttributes(line, directive[1]!, tag)
    const index = marker.entries.push({ attributes, kind: tag }) - 1
    stack.push({ coverage: index })
    lines.push(`<!--${coverageMarkerValue(marker, index, "start")}-->`)
  }
  return lines.join("\n")
}

async function instructionDirectiveAttributes(
  line: string,
  fence: string,
  tag: "capability" | "skill" | "source",
): Promise<Record<string, unknown>> {
  const tree = await parseInstructionMarkdown(`${line}\nvalue\n${fence}`)
  const node = tree.nodes.find(node => isElement(node) && node[0] === tag)
  return node && isElement(node) ? node[1] : {}
}

async function stripMarkedInstructionCoverage(
  content: string,
  marker: InstructionCoverageMarker,
  coverage: InstructionCoverage | undefined,
): Promise<string> {
  let stripped = content
  for (const [index, entry] of marker.entries.entries()) {
    const start = `<!--${coverageMarkerValue(marker, index, "start")}-->`
    const end = `<!--${coverageMarkerValue(marker, index, "end")}-->`
    if (stripped.includes(start)) recordInstructionCoverage(entry.kind, entry.attributes, coverage)
    stripped = stripped
      .replace(new RegExp(`${escapeRegExp(start)}(?:\\r?\\n){0,2}`), "")
      .replace(new RegExp(`(?:\\r?\\n){0,2}${escapeRegExp(end)}`), "")
  }
  return cleanMarkdown(stripped)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function coverageMarkerValue(
  marker: InstructionCoverageMarker,
  index: number,
  boundary: "end" | "start",
): string {
  return `${marker.prefix}-${index}-${boundary}`
}

function rethrowInstructionCompositionError(error: unknown): never {
  if (!(error instanceof Error)) throw error
  const message = error.message
    .replaceAll("Markdown template fragment", "Instruction markdown binding")
    .replaceAll("Markdown template binding", "Instruction binding")
    .replaceAll("Markdown template", "Instruction")
    .replaceAll("Unsafe Instruction condition", "Unsafe instruction condition")
    .replaceAll("Invalid Instruction condition", "Invalid instruction condition")
    .replaceAll("read data paths", "read context.* paths")
  throw error instanceof TypeError ? new TypeError(message) : new Error(message)
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

function createInstructionMarkdownRuntime(): InstructionMarkdownRuntime {
  const rawTag = `vitehub-instruction-raw-${crypto.randomUUID().replaceAll("-", "")}`
  return {
    components: {
      Binding,
      [rawTag]: (node: ComarkElement) => typeof node[1].value === "string" ? node[1].value : "",
    },
    rawTag,
  }
}

function createInstructionProtectedTokens(): InstructionProtectedTokens {
  return {
    prefix: `VITEHUBINSTRUCTIONPROTECTED${crypto.randomUUID().replaceAll("-", "")}`,
    values: [],
  }
}

function restoreInstructionProtectedTokens(
  content: string,
  protectedTokens: InstructionProtectedTokens,
): string {
  return content.replace(
    new RegExp(`${protectedTokens.prefix}(\\d+)END`, "g"),
    (_match, index: string) => protectedTokens.values[Number(index)] ?? _match,
  )
}

function cleanMarkdown(content: string): string {
  return content.trim()
}

async function parseInstructionTemplate(content: string, bindings = false) {
  const tags: InstructionTemplateTags = {
    prefix: `VITEHUBINSTRUCTIONTAG${crypto.randomUUID().replaceAll("-", "")}`,
    values: [],
  }
  const tree = await parseInstructionMarkdown(maskInstructionTags(content, tags), bindings)
  return { tags, tree }
}

async function renderInstructionTemplate(
  tree: Awaited<ReturnType<typeof parseInstructionMarkdown>>,
  nodes: ComarkNode[],
  tags: InstructionTemplateTags,
  components: Record<string, NodeHandler>,
): Promise<string> {
  const rendered = cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components }))
  return restoreInstructionTags(rendered, tags)
}

function maskInstructionTags(content: string, tags: InstructionTemplateTags): string {
  return content.replace(/<\/?[A-Za-z][^<>]*>/g, (tag) => {
    const index = tags.values.push(tag) - 1
    return `${tags.prefix}${index}END`
  })
}

function restoreInstructionTags(content: string, tags: InstructionTemplateTags): string {
  return content.replace(
    new RegExp(`${tags.prefix}(\\d+)END`, "g"),
    (_match, index: string) => tags.values[Number(index)] ?? _match,
  )
}

async function expandInstructionImports(
  content: string,
  options: ResolveInstructionImportsOptions & {
    maxDepth: number
    protectedTokens: InstructionProtectedTokens
    runtime: InstructionMarkdownRuntime
    seen: Set<string>
  },
  depth = 0,
): Promise<string> {
  const { tags, tree } = await parseInstructionTemplate(content)
  const nodes = await expandImportNodes(tree.nodes, options, depth)
  const rendered = await renderInstructionTemplate(tree, nodes, tags, options.runtime.components)
  return content.endsWith("\n") ? `${rendered}\n` : rendered
}

async function expandImportNodes(
  nodes: ComarkNode[],
  options: ResolveInstructionImportsOptions & { maxDepth: number, protectedTokens: InstructionProtectedTokens, runtime: InstructionMarkdownRuntime, seen: Set<string> },
  depth: number,
): Promise<ComarkNode[]> {
  const expanded: ComarkNode[] = []
  for (const node of nodes) expanded.push(...await expandImportNode(node, options, depth))
  return expanded
}

async function expandImportNode(
  node: ComarkNode,
  options: ResolveInstructionImportsOptions & { maxDepth: number, protectedTokens: InstructionProtectedTokens, runtime: InstructionMarkdownRuntime, seen: Set<string> },
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
  options: ResolveInstructionImportsOptions & { maxDepth: number, protectedTokens: InstructionProtectedTokens, runtime: InstructionMarkdownRuntime, seen: Set<string> },
  depth: number,
): Promise<ComarkNode[]> {
  const nodes: ComarkNode[] = []
  let textNode = ""
  let index = 0
  for (const match of text.matchAll(/@[^\s<>{}[\]]+/g)) {
    textNode += text.slice(index, match.index)
    const token = match[0]
    const replacement = await importReplacement(token, options, depth)
    if (replacement === undefined) {
      textNode += token
    }
    else {
      if (textNode) nodes.push(textNode)
      nodes.push(rawMarkdownNode(replacement, options.runtime))
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
  protectedTokens: InstructionProtectedTokens = createInstructionProtectedTokens(),
): Promise<string> {
  let expanded = ""
  let offset = 0
  for (const match of content.matchAll(/@workspace(?:\.[A-Za-z_$][\w$-]*)+/g)) {
    expanded += content.slice(offset, match.index)
    expanded += await workspaceImportReplacement(match[0], workspace, depth, seen, protectedTokens)
    offset = match.index + match[0].length
  }
  return expanded + content.slice(offset)
}

function rawMarkdownNode(value: string, runtime: InstructionMarkdownRuntime): ComarkElement {
  return [runtime.rawTag, { value }]
}

async function workspaceImportReplacement(
  token: string,
  workspace: Record<string, unknown>,
  depth: number,
  seen: Set<string>,
  protectedTokens: InstructionProtectedTokens,
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
    return await expandWorkspaceInstructionImports(
      await normalizeDynamicConditionShorthand(value, protectedTokens),
      workspace,
      depth + 1,
      seen,
      protectedTokens,
    )
  }
  finally {
    seen.delete(path)
  }
}

async function importReplacement(
  token: string,
  options: ResolveInstructionImportsOptions & { maxDepth: number, protectedTokens: InstructionProtectedTokens, runtime: InstructionMarkdownRuntime, seen: Set<string> },
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
    return `${await expandInstructionImports(await normalizeDynamicConditionShorthand(resolved.content, options.protectedTokens), { ...options, file: resolved.file }, depth + 1)}${trailing}`
  }
  finally {
    options.seen.delete(resolved.file)
  }
}

async function normalizeDynamicConditionShorthand(
  content: string,
  protectedTokens: InstructionProtectedTokens,
): Promise<string> {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const prefix = `VITEHUBINSTRUCTIONCANDIDATE${nonce}`
  const candidates: Array<{ kind: "directive" | "syntax", value: string }> = []
  let masked = content.replace(/^(\s*)(::[^\r\n]*)$/gm, (_match, indentation: string, directive: string) => {
    const index = candidates.push({ kind: "directive", value: directive }) - 1
    return `${indentation}${prefix}${index}END`
  })
  masked = masked.replace(/\{\{\{[^{}\r\n]*\}\}\}|\{\{[^{}\r\n]*\}\}/g, (binding) => {
    const index = candidates.push({ kind: "syntax", value: binding }) - 1
    return `${prefix}${index}END`
  })
  masked = masked.replace(/@[^\s<>{}[\]]+/g, (specifier) => {
    const index = candidates.push({ kind: "syntax", value: specifier }) - 1
    return `${prefix}${index}END`
  })
  if (!candidates.length) return content

  const { tree } = await parseInstructionTemplate(masked)
  const inCode = instructionDirectiveTokensInCode(tree.nodes, prefix)
  return masked.replace(new RegExp(`${prefix}(\\d+)END`, "g"), (_match, index: string) => {
    const candidate = candidates[Number(index)]
    if (!candidate) return _match
    if (!inCode.has(Number(index))) {
      return candidate.kind === "directive" ? normalizeConditionDirective(candidate.value) : candidate.value
    }
    const protectedIndex = protectedTokens.values.push(candidate.value) - 1
    return `${protectedTokens.prefix}${protectedIndex}END`
  })
}

function normalizeConditionDirective(directive: string): string {
  return directive.replace(/^(::(?:if|else-if))\{([\s\S]+)\}(\s*)$/, (match, start: string, expression: string, end: string) =>
    /^(?:if|condition)\s*=/.test(expression.trim())
      ? match
      : `${start}{condition=${JSON.stringify(expression.trim())}}${end}`)
}

async function instructionDirectiveValidationSource(content: string): Promise<string> {
  const prefix = `VITEHUBINSTRUCTIONVALIDATION${crypto.randomUUID().replaceAll("-", "")}`
  const directives: string[] = []
  const masked = content.replace(/^(\s*)(::[^\r\n]*)$/gm, (_match, indentation: string, directive: string) => {
    const index = directives.push(directive) - 1
    return `${indentation}${prefix}${index}END`
  })
  if (!directives.length) return content

  const { tree } = await parseInstructionTemplate(masked)
  const inCode = instructionDirectiveTokensInCode(tree.nodes, prefix)
  return masked.replace(new RegExp(`${prefix}(\\d+)END`, "g"), (_match, index: string) =>
    inCode.has(Number(index)) ? "code" : directives[Number(index)] ?? _match)
}

function instructionDirectiveTokensInCode(
  nodes: ComarkNode[],
  prefix: string,
  inCode = false,
): Set<number> {
  const found = new Set<number>()
  for (const node of nodes) {
    if (typeof node === "string") {
      if (inCode) {
        for (const match of node.matchAll(new RegExp(`${prefix}(\\d+)END`, "g"))) found.add(Number(match[1]))
      }
      continue
    }
    if (!isElement(node)) continue
    const nested = instructionDirectiveTokensInCode(
      node.slice(2) as ComarkNode[],
      prefix,
      inCode || node[0] === "code",
    )
    for (const index of nested) found.add(index)
  }
  return found
}

function normalizeStaticConditionShorthand(content: string): string {
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

function stripStaticInstructionCoverageDirectives(content: string): string {
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
  const stack: Array<{ kind: "if", sawElse: boolean } | { kind: "other" }> = []
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
    if (!directive) {
      if (/^\s*::[A-Za-z][\w-]*(?:\{.*\})?\s*$/.test(line)) stack.push({ kind: "other" })
      continue
    }
    if (directive.kind === "if") {
      stack.push({ kind: "if", sawElse: false })
      continue
    }

    const current = stack.at(-1)
    if (!current || current.kind !== "if") {
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

  if (stack.some(entry => entry.kind === "if")) {
    throw new Error("[vitehub] Instruction if block is missing a closing :: line.")
  }
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
      return !parseUnary()
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
