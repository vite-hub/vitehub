import { parseMarkdown } from "comark"
import type { ElementNode, Node } from "comark"

import { assertBindingRoot } from "../bindings.ts"
import { markdownTemplateErrorDiagnostics as diagnostics } from "../error-diagnostics.ts"
import { hasMarkdownHtmlChildren, literalHtmlTags, parserOptions } from "../parser.ts"
import { prepareTemplate } from "../prepare.ts"

type DataUse = "condition" | "markdown" | "scalar"

interface DataField {
  children: Map<string, DataField>
  required: boolean
  use?: DataUse
}

/** The `data` type that a template reads, as TypeScript source. `required` is true when `data` must be passed. */
export interface MarkdownTemplateDataType {
  required: boolean
  type: string
}

const usePriority: Record<DataUse, number> = { condition: 0, scalar: 1, markdown: 2 }
const typeByUse: Record<DataUse, string> = { condition: "unknown", markdown: "string", scalar: "string | number | boolean" }
const conditionTags = new Set(["if", "else-if", "else"])
const bindingTags = new Set(["a", "binding", "insert", ...conditionTags])

function emptyField(): DataField {
  return { children: new Map(), required: false }
}

function dataPath(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.startsWith("data.")) return
  const parts = value.slice("data.".length).split(".")
  return parts.every(Boolean) ? parts : undefined
}

function addPath(root: DataField, parts: string[], use: DataUse, required: boolean): void {
  let field = root
  for (const part of parts) {
    let child = field.children.get(part)
    if (!child) field.children.set(part, child = emptyField())
    child.required ||= required
    field = child
  }
  if (!field.use || usePriority[use] > usePriority[field.use]) field.use = use
}

function addAttributes(root: DataField, [tag, attributes]: ElementNode, required: boolean): void {
  const condition = conditionTags.has(tag)
  const resolvesBindings = bindingTags.has(tag) || attributes.$?.html === 1
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(":")) continue
    if (resolvesBindings && typeof value === "string") assertBindingRoot(value)
    const parts = dataPath(value)
    if (!parts) continue
    if (condition) addPath(root, parts, "condition", false)
    else addPath(root, parts, tag === "insert" && key === ":markdown" ? "markdown" : "scalar", required)
  }
}

async function visitCondition(root: DataField, [tag, attributes, ...children]: ElementNode, required: boolean): Promise<void> {
  addAttributes(root, [tag, attributes], false)
  let afterBranch = false
  for (const child of children) {
    if (Array.isArray(child) && (child[0] === "else-if" || child[0] === "else")) {
      await visitCondition(root, child, required)
      afterBranch = true
    }
    else await visit(root, [child], afterBranch && required)
  }
}

async function visit(root: DataField, nodes: Node[], required: boolean): Promise<void> {
  for (const node of nodes) {
    if (!Array.isArray(node) || node[0] === null) continue
    if (node[0] === "if") {
      await visitCondition(root, node, required)
      continue
    }
    addAttributes(root, node, required)
    await visit(root, await templateChildren(node), required)
  }
}

async function templateChildren(node: ElementNode): Promise<Node[]> {
  // SAFETY: Comark element tuple entries after the tag and attributes are child nodes.
  const children = node.slice(2) as Node[]
  return hasMarkdownHtmlChildren(node) ? (await parseMarkdown(children.join(""), parserOptions)).nodes : children
}

function renderOptional(field: DataField, type: string): string {
  return field.required || type === "unknown" ? type : `${type} | null`
}

function renderField(field: DataField, indent: string): string {
  if (!field.children.size) return typeByUse[field.use ?? "condition"]
  const inner = `${indent}  `
  const entries = [...field.children].map(([key, child]) => `${inner}${JSON.stringify(key)}${child.required ? "" : "?"}: ${renderOptional(child, renderField(child, inner))}`)
  return `{\n${entries.join("\n")}\n${indent}}`
}

/**
 * Infers the `data` type of a template from its `data.*` bindings. A value read only inside an `::if` branch is
 * optional and takes `null`, and a condition value is optional `unknown`.
 */
export async function inferMarkdownTemplateDataType(template: string, indent = ""): Promise<MarkdownTemplateDataType> {
  const prepared = await prepareTemplate(template)
  const root = emptyField()
  await visit(root, (await parseMarkdown(prepared.template, parserOptions)).nodes, true)
  if (!root.children.size) return { required: false, type: "Record<string, never>" }
  return { required: [...root.children.values()].some(field => field.required), type: renderField(root, indent) }
}

function bindingInText(text: string): string | undefined {
  let offset = 0
  while (offset < text.length) {
    const start = text.indexOf("{{", offset)
    if (start === -1) return
    const end = text.indexOf("}}", start + 2)
    if (end === -1) return
    const path = text.slice(start + 2, end).split("||", 1)[0]?.trim()
    if (path) return path
    offset = end + 2
  }
}

async function findBindingInCode(nodes: Node[], restore: (text: string) => string, literal = false): Promise<string | undefined> {
  for (const node of nodes) {
    if (typeof node === "string") {
      const path = literal ? bindingInText(restore(node)) : undefined
      if (path) return path
      continue
    }
    if (node[0] === null) continue
    const found = await findBindingInCode(await templateChildren(node), restore, literal || literalHtmlTags.has(node[0]))
    if (found) return found
  }
  return undefined
}

/**
 * Rejects a `{{ ... }}` binding inside inline code or a code block. The renderer keeps it as text, which suits a
 * page that documents the syntax, but a template file such as an Email template expects the value there.
 */
export async function assertNoBindingsInCode(template: string): Promise<void> {
  const prepared = await prepareTemplate(template)
  const path = await findBindingInCode((await parseMarkdown(prepared.template, parserOptions)).nodes, prepared.restore)
  if (path) throw diagnostics.MARKDOWN_TEMPLATE_BINDING_IN_CODE({ path })
}
