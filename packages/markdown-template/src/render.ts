import { characterEntitiesLegacy } from "character-entities-legacy"
import { renderMarkdown } from "comark/render"

import { evaluateCondition, templatePathValue } from "./condition.ts"
import { expandMarkdownTemplateImports } from "./imports.ts"
import {
  cleanMarkdown,
  createMarkdownTemplateRuntime,
  parseTemplateMarkdown,
} from "./markdown.ts"

import type { ComarkElement, ComarkNode } from "./ast.ts"
import type { MarkdownTemplateRuntime } from "./markdown.ts"
import type {
  RenderMarkdownTemplateInternalOptions,
  RenderMarkdownTemplateOptions,
  ResolveMarkdownTemplateImportsOptions,
} from "./types.ts"

interface RenderState {
  data: Record<string, unknown>
  fragmentToken: string
  fragments: Array<{ path: string }>
  linkToken: string
  links: Array<{ path: string }>
  validateConditionPath?: (path: string) => boolean
}

interface TemplateTokenState {
  prefix: string
  values: string[]
}

const defaultImportDepth = 4
const templatePathSource = String.raw`[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*`
const templatePathPattern = new RegExp(`^${templatePathSource}$`)
const tripleBindingPattern = new RegExp(String.raw`\{\{\{\s*(${templatePathSource})\s*\}\}\}`, "g")
const tagBindingPattern = new RegExp(String.raw`(?<!\{)\{\{(?!\{)\s*(${templatePathSource})\s*\}\}(?!\})`, "g")
const legacyHtmlReferences = new Set(characterEntitiesLegacy)

interface TemplatePreparation {
  prepare: (value: string) => Promise<string>
  protectedTokens: TemplateTokenState
  runtime: MarkdownTemplateRuntime
  tagTokens: TemplateTokenState
}

export async function resolveMarkdownTemplateImports(
  template: string,
  options: ResolveMarkdownTemplateImportsOptions,
): Promise<string> {
  assertTemplate(template)
  const preparation = createTemplatePreparation()
  const imported = await expandPreparedImports(await preparation.prepare(template), options, preparation)
  return restoreTemplateTokens(restoreTemplateTags(imported, preparation.tagTokens), preparation.protectedTokens)
}

export async function renderMarkdownTemplate(
  template: string,
  options: RenderMarkdownTemplateOptions = {},
): Promise<string> {
  return await renderMarkdownTemplateInternal(template, options)
}

export async function renderMarkdownTemplateInternal(
  template: string,
  options: RenderMarkdownTemplateInternalOptions = {},
): Promise<string> {
  assertTemplate(template)
  const data = options.data ?? {}
  const preparation = createTemplatePreparation()
  const shorthand = await preparation.prepare(template)
  const imported = options.resolveImport
    ? await expandPreparedImports(shorthand, {
        maxImportDepth: options.maxImportDepth,
        resolveImport: options.resolveImport,
        sourceId: options.sourceId,
      }, preparation)
    : shorthand
  validateConditionalDirectives(await directiveValidationSource(imported))
  const normalizedLinks = await normalizeLinkBindings(imported)
  const fragmentToken = `VITEHUBMARKDOWNTEMPLATEFRAGMENT${crypto.randomUUID().replaceAll("-", "")}`
  const normalized = await normalizeTripleBindings(normalizedLinks.template, fragmentToken, preparation.runtime)
  const tree = await parseTemplateMarkdown(normalized.template, true)
  const nodes = await composeNodes(tree.nodes, {
    data,
    fragmentToken,
    fragments: normalized.fragments,
    linkToken: normalizedLinks.token,
    links: normalizedLinks.links,
    validateConditionPath: options.validateConditionPath,
  })
  const rendered = cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components: preparation.runtime.components }))
  return restoreTemplateTokens(restoreTemplateTags(rendered, preparation.tagTokens, data), preparation.protectedTokens)
}

async function normalizeLinkBindings(template: string): Promise<{
  links: RenderState["links"]
  template: string
  token: string
}> {
  const token = `VITEHUBMARKDOWNTEMPLATELINK${crypto.randomUUID().replaceAll("-", "")}`
  const candidates: Array<{ binding: string, path: string }> = []
  const prepared = template.replace(tagBindingPattern, (binding, path: string, offset: number, source: string) => {
    const prefix = source.slice(0, offset)
    const suffix = source.slice(offset + binding.length)
    const closesDestination = /^\s*\)/.test(suffix)
      || /^\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*\)/.test(suffix)
    const closesEnclosedDestination = /^\s*>\s*\)/.test(suffix)
      || /^\s*>\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*\)/.test(suffix)
    const completeDestination = /\]\(\s*$/.test(prefix) && closesDestination
    const completeEnclosedDestination = /\]\(\s*<\s*$/.test(prefix) && closesEnclosedDestination
    if (!completeDestination && !completeEnclosedDestination) {
      return binding
    }
    const index = candidates.push({ binding, path }) - 1
    return `${token}${index}END`
  })
  if (!candidates.length) return { links: [], template, token }

  const tree = await parseTemplateMarkdown(prepared)
  const linked = linkBindingIndices(tree.nodes, token)
  let rendered = prepared
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!
    if (!linked.has(index)) rendered = rendered.replace(`${token}${index}END`, candidate.binding)
  }
  return { links: candidates, template: rendered, token }
}

function linkBindingIndices(nodes: ComarkNode[], token: string): Set<number> {
  const found = new Set<number>()
  for (const node of nodes) {
    if (!isElement(node)) continue
    if (node[0] === "a" && typeof node[1].href === "string") {
      const match = node[1].href.match(new RegExp(`^${token}(\\d+)END$`))
      if (match) found.add(Number(match[1]))
    }
    for (const index of linkBindingIndices(node.slice(2) as ComarkNode[], token)) found.add(index)
  }
  return found
}

async function safeLinkDestination(path: string, data: Record<string, unknown>): Promise<string> {
  const value = scalarValue(path, data)
  const suffixIndex = value.search(/[?#]/)
  const scheme = value.match(/^([a-z][a-z\d+.-]*):/i)
  const hierarchical = !scheme
    || /^(?:file|ftp|https?|wss?)$/i.test(scheme[1]!)
    || value[scheme[0].length] === "/"
  const hasPathBackslash = hierarchical
    && value.slice(0, suffixIndex < 0 ? undefined : suffixIndex).includes("\\")
  const hasHtmlReferencePrefix = /&#(?:\d+|x[\dA-F]+)/i.test(value)
    || [...value.matchAll(/&([A-Za-z][A-Za-z\d]*)(?=[^=A-Za-z\d]|$)/g)]
      .some(match => legacyHtmlReferences.has(match[1]!))
  if (value.trim() !== value || hasPathBackslash || hasHtmlReferencePrefix || /^(?:[a-z][a-z\d+.-]*:)?\/{2,}(?:[^/?#]*@)?\[/i.test(value) || [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 32 || codePoint === 127
  })) {
    throw new Error(`[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.`)
  }
  let encoded: string
  try {
    encoded = encodeURI(value)
    encoded = encoded
      .replace(/%25([\dA-F]{2})/gi, "%$1")
      .replace(/[()]/g, character => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)
  }
  catch {
    throw new Error(`[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.`)
  }

  const tree = await parseTemplateMarkdown(`[link](<${encoded}>)`)
  const paragraph = tree.nodes[0]
  const link = isElement(paragraph) && paragraph[0] === "p" ? paragraph[2] : undefined
  if (!link || !isElement(link) || link[0] !== "a" || link[1].href !== encoded) {
    throw new Error(`[vitehub] Markdown template link binding "{{ ${path} }}" must resolve to a safe destination.`)
  }
  return encoded
}

function assertTemplate(template: string): void {
  if (typeof template !== "string") {
    throw new TypeError("[vitehub] Markdown template must be a string.")
  }
}

function createTemplatePreparation(): TemplatePreparation {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const protectedTokens: TemplateTokenState = {
    prefix: `VITEHUBMARKDOWNTEMPLATEPROTECTED${nonce}`,
    values: [],
  }
  const tagTokens: TemplateTokenState = {
    prefix: `VITEHUBMARKDOWNTEMPLATETAG${nonce}`,
    values: [],
  }
  return {
    prepare: async (value) => {
      const prepared = maskTemplateTags(
        await protectCodeTemplateSyntax(value, protectedTokens, nonce),
        tagTokens,
      )
      validateConditionalDirectives(await directiveValidationSource(prepared))
      return prepared
    },
    protectedTokens,
    runtime: createMarkdownTemplateRuntime(nonce),
    tagTokens,
  }
}

async function expandPreparedImports(
  template: string,
  options: ResolveMarkdownTemplateImportsOptions,
  preparation: TemplatePreparation,
): Promise<string> {
  return await expandMarkdownTemplateImports(template, {
    maxImportDepth: options.maxImportDepth ?? defaultImportDepth,
    prepare: preparation.prepare,
    resolveBareImport: options.resolveBareImport,
    resolveImport: options.resolveImport,
    runtime: preparation.runtime,
    sourceId: options.sourceId ?? "<template>",
  })
}

function maskTemplateTags(
  template: string,
  state: TemplateTokenState,
): string {
  return template.replace(/<\/?[A-Za-z][^<>]*>/g, (tag) => {
    const index = state.values.push(tag) - 1
    return `${state.prefix}${index}END`
  })
}

function restoreTemplateTags(
  template: string,
  state: TemplateTokenState,
  data?: Record<string, unknown>,
): string {
  return template.replace(
    new RegExp(`${state.prefix}(\\d+)END`, "g"),
    (_match, index: string) => {
      const tag = state.values[Number(index)]
      return tag === undefined ? _match : data ? renderTagBindings(tag, data) : tag
    },
  )
}

function renderTagBindings(tag: string, data: Record<string, unknown>): string {
  return tag.replace(/(\s[^\s"'=<>`]+\s*=\s*)(["'])([\s\S]*?)\2/g, (_match, prefix: string, quote: string, value: string) => {
    const rendered = value.replace(tagBindingPattern, (_binding, path: string) =>
      escapeHtmlAttribute(scalarValue(path, data)))
    return `${prefix}${quote}${rendered}${quote}`
  })
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function restoreTemplateTokens(template: string, state: TemplateTokenState): string {
  return template.replace(
    new RegExp(`${state.prefix}(\\d+)END`, "g"),
    (_match, index: string) => state.values[Number(index)] ?? _match,
  )
}

async function protectCodeTemplateSyntax(
  template: string,
  protectedTokens: TemplateTokenState,
  nonce: string,
): Promise<string> {
  const candidates: Array<{ kind: "directive" | "syntax", value: string }> = []
  const prefix = `VITEHUBMARKDOWNTEMPLATECANDIDATE${nonce}`
  let masked = template.replace(/^(\s*)(::[^\r\n]*)$/gm, (_match, indentation: string, directive: string) => {
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
  if (!candidates.length) return template

  const tree = await parseTemplateMarkdown(masked)
  const inCode = directiveTokensInCode(tree.nodes, prefix)
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

async function normalizeTripleBindings(
  template: string,
  fragmentToken: string,
  runtime: MarkdownTemplateRuntime,
): Promise<{
  fragments: RenderState["fragments"]
  template: string
}> {
  const fragments: RenderState["fragments"] = []
  const tree = await parseTemplateMarkdown(template)
  const nodes = replaceTextOutsideCode(tree.nodes, value =>
    value.replace(tripleBindingPattern, (_match, path: string) => {
      const index = fragments.push({ path }) - 1
      return `${fragmentToken}${index}END`
    }))
  return {
    fragments,
    template: await renderMarkdown({ ...tree, nodes }, { components: runtime.components }),
  }
}

async function directiveValidationSource(
  template: string,
): Promise<string> {
  const nonce = crypto.randomUUID().replaceAll("-", "")
  const prefix = `VITEHUBMARKDOWNTEMPLATEVALIDATION${nonce}`
  const directives: string[] = []
  const masked = template.replace(/^(\s*)(::[^\r\n]*)$/gm, (_match, indentation: string, directive: string) => {
    const index = directives.push(directive) - 1
    return `${indentation}${prefix}${index}END`
  })
  if (!directives.length) return template

  const tree = await parseTemplateMarkdown(masked)
  const inCode = directiveTokensInCode(tree.nodes, prefix)
  return masked.replace(new RegExp(`${prefix}(\\d+)END`, "g"), (_match, index: string) =>
    inCode.has(Number(index)) ? "code" : directives[Number(index)] ?? _match)
}

function directiveTokensInCode(nodes: ComarkNode[], prefix: string, inCode = false): Set<number> {
  const found = new Set<number>()
  for (const node of nodes) {
    if (typeof node === "string") {
      if (inCode) {
        for (const match of node.matchAll(new RegExp(`${prefix}(\\d+)END`, "g"))) found.add(Number(match[1]))
      }
      continue
    }
    if (!isElement(node)) continue
    const nested = directiveTokensInCode(node.slice(2) as ComarkNode[], prefix, inCode || node[0] === "code")
    for (const index of nested) found.add(index)
  }
  return found
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
  state: RenderState,
  parent?: string,
  inlineFragments?: Set<number>,
): Promise<ComarkNode[]> {
  const composed: ComarkNode[] = []
  for (const node of nodes) composed.push(...await composeNode(node, state, parent, inlineFragments))
  return composed
}

async function composeNode(
  node: ComarkNode,
  state: RenderState,
  parent?: string,
  inlineFragments?: Set<number>,
): Promise<ComarkNode[]> {
  if (typeof node === "string") return await composeTextNode(node, state, parent, inlineFragments)
  if (!isElement(node)) return [node]
  const [tag, attrs, ...children] = node

  if (tag === "if") return await composeIfNode(node, state)
  if (tag === "else" || tag === "else-if") {
    throw new Error(`[vitehub] Markdown template ${tag} block must follow an if block.`)
  }
  if (tag === "binding") return [renderBinding(attrs, state.data)]
  if (tag === "code") return [node]
  if (tag === "p") return await composeParagraph(attrs, children, state)
  const composedAttrs = tag === "a" ? await composeLinkAttributes(attrs, state) : attrs
  return [[tag, composedAttrs, ...(await composeNodes(
    children,
    state,
    tag,
    inlineFragments,
  ))] as ComarkElement]
}

async function composeLinkAttributes(
  attrs: Record<string, unknown>,
  state: RenderState,
): Promise<Record<string, unknown>> {
  if (typeof attrs.href !== "string") return attrs
  const match = attrs.href.match(new RegExp(`^${state.linkToken}(\\d+)END$`))
  const link = match ? state.links[Number(match[1])] : undefined
  return link ? { ...attrs, href: await safeLinkDestination(link.path, state.data) } : attrs
}

async function composeParagraph(
  attrs: Record<string, unknown>,
  children: ComarkNode[],
  state: RenderState,
): Promise<ComarkNode[]> {
  const inlineFragments = paragraphInlineFragments(children, state)
  const pattern = fragmentPlaceholderPattern(state)
  const composed: ComarkNode[] = []
  let segment: ComarkNode[] = []
  let hasBlockFragment = false
  let trimLeadingBoundary = false

  const flushSegment = async () => {
    const nodes = await composeNodes(segment, state, "p", inlineFragments)
    if (hasMeaningfulContent(nodes)) composed.push(["p", attrs, ...nodes] as ComarkElement)
    segment = []
  }

  for (const child of children) {
    if (typeof child !== "string") {
      segment.push(child)
      continue
    }

    let offset = 0
    for (const match of child.matchAll(pattern)) {
      const index = Number(match[1])
      if (inlineFragments.has(index)) continue

      hasBlockFragment = true
      let before = child.slice(offset, match.index)
      if (trimLeadingBoundary) {
        before = before.replace(/^\r?\n/, "")
        trimLeadingBoundary = false
      }
      before = before.replace(/\r?\n$/, "")
      if (before) segment.push(before)
      await flushSegment()
      composed.push(...await fragmentNodes(index, state, false))
      trimLeadingBoundary = true
      offset = match.index + match[0].length
    }

    let after = child.slice(offset)
    if (trimLeadingBoundary) {
      after = after.replace(/^\r?\n/, "")
      trimLeadingBoundary = false
    }
    if (after) segment.push(after)
  }

  if (!hasBlockFragment) {
    return [["p", attrs, ...await composeNodes(children, state, "p", inlineFragments)] as ComarkElement]
  }
  await flushSegment()
  return composed
}

async function composeTextNode(
  value: string,
  state: RenderState,
  parent?: string,
  inlineFragments?: Set<number>,
): Promise<ComarkNode[]> {
  const nodes: ComarkNode[] = []
  let offset = 0

  for (const match of value.matchAll(fragmentPlaceholderPattern(state))) {
    nodes.push(value.slice(offset, match.index))
    const index = Number(match[1])
    nodes.push(...(state.fragments[index]
      ? await fragmentNodes(index, state, parent !== undefined || inlineFragments?.has(index) === true)
      : [match[0]]))
    offset = match.index + match[0].length
  }

  nodes.push(value.slice(offset))
  return nodes.filter(node => node !== "")
}

function paragraphInlineFragments(children: ComarkNode[], state: RenderState): Set<number> {
  const inline = new Set<number>()
  const placement = fragmentPlacementText(children)
  for (const match of placement.matchAll(fragmentPlaceholderPattern(state))) {
    const before = placement.slice(0, match.index).split("\n").at(-1) ?? ""
    const after = placement.slice(match.index + match[0].length).split("\n")[0] ?? ""
    if (before.trim() || after.trim()) inline.add(Number(match[1]))
  }
  return inline
}

function fragmentPlacementText(nodes: ComarkNode[]): string {
  return nodes.map((node) => {
    if (typeof node === "string") return node
    if (!isElement(node)) return ""
    if (node[0] === "code") return "x"
    return `x${fragmentPlacementText(node.slice(2) as ComarkNode[])}x`
  }).join("")
}

function renderBinding(attrs: Record<string, unknown>, data: Record<string, unknown>): ComarkNode {
  const path = attrs[":value"]
  if (typeof path !== "string" || !templatePathPattern.test(path)) {
    throw new Error("[vitehub] Markdown template bindings must contain a data path.")
  }

  return scalarValue(path, data)
}

function scalarValue(path: string, data: Record<string, unknown>): string {
  const value = templatePathValue(data, path)
  if (value === null || value === undefined) {
    throw new Error(`[vitehub] Markdown template binding "{{ ${path} }}" is not defined.`)
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  throw new TypeError(`[vitehub] Markdown template binding "{{ ${path} }}" must resolve to a scalar value.`)
}

async function fragmentNodes(
  index: number,
  state: RenderState,
  inline: boolean,
): Promise<ComarkNode[]> {
  const { path } = state.fragments[index]!
  const value = templatePathValue(state.data, path)
  if (value === null || value === undefined) {
    throw new Error(`[vitehub] Markdown template fragment "{{{ ${path} }}}" is not defined.`)
  }
  if (typeof value !== "string") {
    throw new TypeError(`[vitehub] Markdown template fragment "{{{ ${path} }}}" must resolve to a string.`)
  }

  const tree = await parseTemplateMarkdown(value)
  if (inline) {
    if (!tree.nodes.length) return []
    if (tree.nodes.length !== 1 || !isElement(tree.nodes[0]) || tree.nodes[0][0] !== "p") {
      throw new Error(`[vitehub] Markdown template fragment "{{{ ${path} }}}" cannot contain block Markdown when used inline.`)
    }
    return tree.nodes[0].slice(2) as ComarkNode[]
  }
  return tree.nodes
}

function fragmentPlaceholderPattern(state: RenderState): RegExp {
  return new RegExp(`${state.fragmentToken}(\\d+)END`, "g")
}

function hasMeaningfulContent(nodes: ComarkNode[]): boolean {
  return nodes.some(node => typeof node === "string" ? node.trim() : true)
}

async function composeIfNode(node: ComarkElement, state: RenderState): Promise<ComarkNode[]> {
  const { after, branches } = conditionalBranches(node)
  const selected = branches.find(branch =>
    branch.expression === undefined || evaluateCondition(branch.expression, state.data, state.validateConditionPath))
  return [
    ...(selected ? await composeNodes(selected.nodes, state) : []),
    ...await composeNodes(after, state),
  ]
}

function conditionalBranches(node: ComarkElement): {
  after: ComarkNode[]
  branches: Array<{ expression?: string, nodes: ComarkNode[] }>
} {
  const branches: Array<{ expression?: string, nodes: ComarkNode[] }> = []
  let current: ComarkElement | undefined = node
  const after: ComarkNode[] = []

  while (current) {
    const [tag, attrs, ...children] = current
    if (tag === "else" && Object.keys(attrs).length) {
      throw new Error("[vitehub] Markdown template else block does not accept a condition.")
    }
    const expression = tag === "else" ? undefined : conditionExpressionFromAttrs(attrs, tag)
    const nextIndex = children.findIndex(child => isElement(child) && (child[0] === "else-if" || child[0] === "else"))
    if (tag === "else" && nextIndex !== -1) {
      throw new Error("[vitehub] Markdown template else block cannot be followed by another branch.")
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

function conditionExpressionFromAttrs(attrs: Record<string, unknown>, kind: string): string {
  const expression = attrs.condition ?? attrs.if
  if (typeof expression !== "string" || !expression.trim()) {
    throw new Error(`[vitehub] Markdown template ${kind} block requires a condition.`)
  }
  return expression.trim()
}

function validateConditionalDirectives(template: string): void {
  const stack: Array<{ kind: "if", sawElse: boolean } | { kind: "other" }> = []
  let fenced: string | undefined

  for (const line of template.split(/\r?\n/)) {
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
      throw new Error(`[vitehub] Markdown template ${directive.kind} block must follow an if block.`)
    }
    if (directive.kind === "else-if") {
      if (current.sawElse) throw new Error("[vitehub] Markdown template else-if block cannot follow else.")
      continue
    }
    if (directive.raw?.trim()) {
      throw new Error("[vitehub] Markdown template else block does not accept a condition.")
    }
    if (current.sawElse) {
      throw new Error("[vitehub] Markdown template if chain cannot contain more than one else block.")
    }
    current.sawElse = true
  }

  if (stack.some(entry => entry.kind === "if")) {
    throw new Error("[vitehub] Markdown template if block is missing a closing :: line.")
  }
}

function directiveLine(line: string): {
  expression?: string
  kind: "else" | "else-if" | "if"
  raw?: string
} | undefined {
  const match = line.match(/^\s*::(if|else-if|else)(?:\{(.+)\})?\s*$/)
  if (!match) return
  const kind = match[1] as "else" | "else-if" | "if"
  if (kind === "else") {
    if (match[2]?.trim()) {
      throw new Error("[vitehub] Markdown template else block does not accept a condition.")
    }
    return { kind, raw: match[2] }
  }
  const expression = conditionExpression(match[2])
  if (!expression) {
    throw new Error(`[vitehub] Markdown template ${kind} block requires a condition.`)
  }
  return { expression, kind, raw: match[2] }
}

function conditionExpression(raw: string | undefined): string | undefined {
  const value = raw?.trim()
  if (!value) return
  const attr = value.match(/^(?:if|condition)\s*=\s*(["'])([\s\S]*)\1$/)
  return (attr ? attr[2] : value).trim()
}

function isElement(node: ComarkNode): node is ComarkElement {
  return Array.isArray(node) && typeof node[0] === "string"
}
