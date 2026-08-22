import { parse } from "comark"
import binding from "comark/plugins/binding"
import {
  renderMarkdownTemplateInternal,
  resolveMarkdownTemplateImports,
} from "@vite-hub/markdown-template/internal/composition"

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

type ComarkElementAttributes = Record<string, unknown>
type ComarkElement = [string, ComarkElementAttributes, ...ComarkNode[]]
type ComarkComment = [null, ComarkElementAttributes, string]
type ComarkNode = ComarkComment | ComarkElement | string

interface InstructionTemplateTags {
  prefix: string
  values: string[]
}

const defaultImportDepth = 4
const contextConditionPathPattern = /^context(?:\.[A-Za-z_$][\w$-]*)+$/
const instructionTripleBindingPattern = /\{\{\{\s*([A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)+)\s*\}\}\}/g

export async function resolveInstructionImports(content: string, options: ResolveInstructionImportsOptions): Promise<string> {
  try {
    return await resolveMarkdownTemplateImports(content, {
      maxImportDepth: options.maxDepth ?? defaultImportDepth,
      resolveImport(specifier, importer) {
        const resolved = options.read(specifier, importer)
        return { id: resolved.file, template: resolved.content }
      },
      sourceId: options.file,
    })
  }
  catch (error) {
    rethrowInstructionCompositionError(error)
  }
}

export async function composeInstructionDocument(content: string, options: ComposeInstructionDocumentOptions = {}): Promise<string> {
  const state = { context: options.context || {}, workspace: options.workspace || {} }
  let imported: string
  try {
    imported = await resolveMarkdownTemplateImports(content, {
      resolveBareImport: specifier => resolveWorkspaceInstructionImport(specifier, state.workspace),
    })
  }
  catch (error) {
    rethrowInstructionCompositionError(error, true)
  }
  await validateInstructionMarkdownBindings(imported)
  const coverageMarker = createInstructionCoverageMarker()
  const marked = await markInstructionCoverage(imported, coverageMarker)

  try {
    const rendered = await renderMarkdownTemplateInternal(marked, {
      data: state,
      validateConditionPath: path => contextConditionPathPattern.test(path),
    })
    return await stripMarkedInstructionCoverage(rendered, coverageMarker, options.coverage)
  }
  catch (error) {
    rethrowInstructionCompositionError(error)
  }
}

async function validateInstructionMarkdownBindings(content: string): Promise<void> {
  if (!content.includes("{{{")) return
  const { tags, tree } = await parseInstructionTemplate(content)
  validateInstructionMarkdownBindingNodes(tree.nodes, tags)
}

function validateInstructionMarkdownBindingNodes(nodes: ComarkNode[], tags: InstructionTemplateTags): void {
  for (const node of nodes) {
    if (typeof node === "string") {
      validateInstructionMarkdownBindingValue(node)
      for (const match of node.matchAll(new RegExp(`${tags.prefix}(\\d+)END`, "g"))) {
        const tag = tags.values[Number(match[1])]
        if (tag) validateInstructionMarkdownBindingValue(tag)
      }
      continue
    }
    if (!isElement(node) || node[0] === "code") continue
    validateInstructionMarkdownBindingNodes(node.slice(2) as ComarkNode[], tags)
  }
}

function validateInstructionMarkdownBindingValue(value: string): void {
  for (const match of value.matchAll(instructionTripleBindingPattern)) {
    const path = match[1]!
    if (!path.startsWith("context.")) {
      throw new Error(`[vitehub] Instruction markdown binding "{{{ ${path} }}}" must use a context.* path. Import Workspace Markdown with @${path}.`)
    }
  }
}

export function createInstructionCoverage(): InstructionCoverage {
  return {
    capabilities: new Set(),
    skills: new Set(),
    sources: new Set(),
  }
}

export async function collectStaticInstructionCoverage(content: string): Promise<InstructionCoverage> {
  const coverage = createInstructionCoverage()
  const marker = createInstructionCoverageMarker()
  const marked = await markInstructionCoverage(content, marker)
  await stripMarkedInstructionCoverage(marked, marker, coverage)
  return coverage
}

function createInstructionCoverageMarker(): InstructionCoverageMarker {
  return {
    entries: [],
    prefix: `vitehub-instruction-coverage-${crypto.randomUUID()}`,
  }
}

async function markInstructionCoverage(
  content: string,
  marker: InstructionCoverageMarker,
): Promise<string> {
  const directivesInCode = await instructionDirectiveLinesInCode(content)
  const stack: Array<{ coverage?: number }> = []
  const lines: string[] = []
  let directiveIndex = 0
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*:{2,}[^\r\n]*$/.test(line) && directivesInCode.has(directiveIndex++)) {
      lines.push(line)
      continue
    }
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

async function instructionDirectiveLinesInCode(content: string): Promise<Set<number>> {
  const prefix = `VITEHUBINSTRUCTIONDIRECTIVE${crypto.randomUUID().replaceAll("-", "")}`
  let index = 0
  const masked = content.replace(/^(\s*)(:{2,}[^\r\n]*)$/gm, (_match, indentation: string) =>
    `${indentation}${prefix}${index++}END`)
  if (!index) return new Set()
  const { tree } = await parseInstructionTemplate(masked)
  return instructionTokensInCode(tree.nodes, prefix)
}

function instructionTokensInCode(nodes: ComarkNode[], prefix: string, inCode = false): Set<number> {
  const found = new Set<number>()
  for (const node of nodes) {
    if (typeof node === "string") {
      if (inCode) {
        for (const match of node.matchAll(new RegExp(`${prefix}(\\d+)END`, "g"))) found.add(Number(match[1]))
      }
      continue
    }
    if (!isElement(node)) continue
    for (const index of instructionTokensInCode(node.slice(2) as ComarkNode[], prefix, inCode || node[0] === "code")) {
      found.add(index)
    }
  }
  return found
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

function rethrowInstructionCompositionError(error: unknown, workspaceImport = false): never {
  if (!(error instanceof Error)) throw error
  let message = error.message
    .replaceAll("Markdown template fragment", "Instruction markdown binding")
    .replaceAll("Markdown template binding", "Instruction binding")
    .replaceAll("Markdown template", "Instruction")
    .replaceAll("Circular Instruction", "Circular instruction")
    .replaceAll("Unsafe Instruction condition", "Unsafe instruction condition")
    .replaceAll("Invalid Instruction condition", "Invalid instruction condition")
    .replaceAll("read data paths", "read context.* paths")
    .replaceAll("must be a relative path", "must be a relative file path")
  if (workspaceImport) {
    message = message
      .replace(/Circular instruction import: (workspace(?:\.[\w$-]+)+)\./, "Circular instruction workspace import: @$1.")
      .replace("Instruction import depth exceeded", "Instruction workspace import depth exceeded")
  }
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

function cleanMarkdown(content: string): string {
  return content.trim()
}

async function parseInstructionTemplate(content: string, bindings = false) {
  const tags: InstructionTemplateTags = {
    prefix: `VITEHUBINSTRUCTIONTAG${crypto.randomUUID().replaceAll("-", "")}`,
    values: [],
  }
  return { tags, tree: await parseInstructionMarkdown(maskInstructionTags(content, tags), bindings) }
}

function maskInstructionTags(content: string, tags: InstructionTemplateTags): string {
  return content.replace(/<\/?[A-Za-z][^<>]*>/g, (tag) => {
    const index = tags.values.push(tag) - 1
    return `${tags.prefix}${index}END`
  })
}

function resolveWorkspaceInstructionImport(
  specifier: string,
  workspace: Record<string, unknown>,
) {
  if (!specifier.startsWith("workspace.")) return
  const value = namespacePathValue(workspace, specifier)
  if (value === null || value === undefined) {
    throw new Error(`[vitehub] Instruction workspace import "@${specifier}" is not defined.`)
  }
  if (typeof value !== "string") {
    throw new TypeError(`[vitehub] Instruction workspace import "@${specifier}" must resolve to a string.`)
  }
  return { id: specifier, template: value }
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

function isElement(node: ComarkNode): node is ComarkElement {
  return Array.isArray(node) && typeof node[0] === "string"
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
