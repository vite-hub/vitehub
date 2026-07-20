import { renderMarkdown } from "comark/render"

import {
  cleanMarkdown,
  parseTemplateMarkdown,
  rawMarkdownNode,
} from "./markdown.ts"

import type { ComarkElement, ComarkNode } from "./ast.ts"
import type { MarkdownTemplateRuntime } from "./markdown.ts"
import type {
  MarkdownTemplateImport,
  ResolveMarkdownTemplateImport,
} from "./types.ts"

interface ExpandMarkdownTemplateImportsOptions {
  maxImportDepth: number
  prepare: (template: string) => Promise<string>
  resolveBareImport?: ResolveMarkdownTemplateImport
  resolveImport?: ResolveMarkdownTemplateImport
  runtime: MarkdownTemplateRuntime
  sourceId: string
}

interface ImportState extends ExpandMarkdownTemplateImportsOptions {
  seen: Set<string>
}

export async function expandMarkdownTemplateImports(
  template: string,
  options: ExpandMarkdownTemplateImportsOptions,
): Promise<string> {
  validateMaxImportDepth(options.maxImportDepth)
  return await expandImports(template, {
    ...options,
    seen: new Set([options.sourceId]),
  }, 0)
}

async function expandImports(template: string, state: ImportState, depth: number): Promise<string> {
  const tree = await parseTemplateMarkdown(template)
  const nodes = await expandImportNodes(tree.nodes, state, depth)
  const rendered = cleanMarkdown(await renderMarkdown({ ...tree, nodes }, { components: state.runtime.components }))
  return template.endsWith("\n") ? `${rendered}\n` : rendered
}

async function expandImportNodes(
  nodes: ComarkNode[],
  state: ImportState,
  depth: number,
): Promise<ComarkNode[]> {
  const expanded: ComarkNode[] = []
  for (const node of nodes) expanded.push(...await expandImportNode(node, state, depth))
  return expanded
}

async function expandImportNode(
  node: ComarkNode,
  state: ImportState,
  depth: number,
): Promise<ComarkNode[]> {
  if (typeof node === "string") return await replaceImports(node, state, depth)
  if (!isElement(node)) return [node]

  const [tag, attrs, ...children] = node
  if (tag === "code") return [node]
  return [[tag, attrs, ...(await expandImportNodes(children, state, depth))] as ComarkElement]
}

async function replaceImports(segment: string, state: ImportState, depth: number): Promise<ComarkNode[]> {
  const nodes: ComarkNode[] = []
  let textNode = ""
  let offset = 0

  for (const match of segment.matchAll(/@[^\s<>{}[\]]+/g)) {
    textNode += segment.slice(offset, match.index)
    const token = match[0]
    const replacement = await importReplacement(token, state, depth)
    if (replacement === undefined) {
      textNode += token
    }
    else {
      if (textNode) nodes.push(textNode)
      nodes.push(rawMarkdownNode(replacement, state.runtime))
      textNode = ""
    }
    offset = match.index + token.length
  }

  textNode += segment.slice(offset)
  if (textNode) nodes.push(textNode)
  return nodes
}

async function importReplacement(token: string, state: ImportState, depth: number): Promise<string | undefined> {
  if (/^@(?:https?:)?\/\//.test(token) || token.startsWith("@/")) {
    if (!state.resolveImport) return
    throw new Error(`[vitehub] Markdown template import "${token}" must be a relative path.`)
  }
  const trailing = token.match(/[.,;:!?)]*$/)?.[0] || ""
  const specifier = token.slice(1, token.length - trailing.length)
  const relative = specifier.startsWith("./") || specifier.startsWith("../")
  const resolveImport = relative ? state.resolveImport : state.resolveBareImport
  if (!resolveImport) return
  if (relative) validateImportRequest(specifier, state, depth)
  const resolved = await resolveImport(specifier, state.sourceId)
  if (!resolved && !relative) return
  if (!relative) validateImportRequest(specifier, state, depth)
  assertImportResolution(resolved, specifier)
  if (state.seen.has(resolved.id)) {
    throw new Error(`[vitehub] Circular Markdown template import: ${specifier}.`)
  }

  state.seen.add(resolved.id)
  try {
    const imported = await expandImports(await state.prepare(resolved.template), {
      ...state,
      sourceId: resolved.id,
    }, depth + 1)
    return `${imported}${trailing}`
  }
  finally {
    state.seen.delete(resolved.id)
  }
}

function validateImportRequest(specifier: string, state: ImportState, depth: number): void {
  if (/[*?]/.test(specifier)) {
    throw new Error(`[vitehub] Markdown template import "${specifier}" cannot use globs.`)
  }
  if (depth >= state.maxImportDepth) {
    throw new Error(`[vitehub] Markdown template import depth exceeded ${state.maxImportDepth}.`)
  }
}

function isElement(node: ComarkNode): node is ComarkElement {
  return Array.isArray(node) && typeof node[0] === "string"
}

function assertImportResolution(
  resolution: MarkdownTemplateImport | undefined,
  specifier: string,
): asserts resolution is MarkdownTemplateImport {
  if (!resolution) {
    throw new Error(`[vitehub] Markdown template import "${specifier}" could not be resolved.`)
  }
  if (!resolution.id || typeof resolution.id !== "string") {
    throw new TypeError(`[vitehub] Markdown template import "${specifier}" must resolve with a non-empty id.`)
  }
  if (typeof resolution.template !== "string") {
    throw new TypeError(`[vitehub] Markdown template import "${specifier}" must resolve with a template string.`)
  }
}

function validateMaxImportDepth(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("[vitehub] Markdown template maxImportDepth must be a non-negative integer.")
  }
}
