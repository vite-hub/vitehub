import { parseMarkdown } from "comark"
import type { ElementNode, Node } from "comark"

import { assertBindingRoot } from "../bindings.ts"
import { markdownTemplateErrorDiagnostics as diagnostics } from "../error-diagnostics.ts"
import { hasMarkdownHtmlChildren, literalHtmlTags, parserOptions } from "../parser.ts"
import { prepareTemplate } from "../prepare.ts"

// `scalar` comes from `{{ data.x }}` and bound attributes, `markdown` from `:insert`, `condition` from `::if` props.
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
  for (const [key, value] of Object.entries(attributes)) {
    if (!key.startsWith(":")) continue
    if (typeof value === "string") assertBindingRoot(value)
    const parts = dataPath(value)
    if (!parts) continue
    // A missing condition value is falsy, so it never fails a render.
    if (condition) addPath(root, parts, "condition", false)
    else addPath(root, parts, tag === "insert" && key === ":markdown" ? "markdown" : "scalar", required)
  }
}

// The renderer shows one branch of an `::if`. Nodes after a nested branch render always, as in `conditionalBranches()`.
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
    // Text and comment nodes bind no data.
    if (!Array.isArray(node) || node[0] === null) continue
    if (node[0] === "if") {
      await visitCondition(root, node, required)
      continue
    }
    addAttributes(root, node, required)
    // SAFETY: Comark element tuple entries after the tag and attributes are child nodes.
    const children = hasMarkdownHtmlChildren(node)
      ? (await parseMarkdown(node.slice(2).join(""), parserOptions)).nodes
      : node.slice(2) as Node[]
    await visit(root, children, required)
  }
}

// The renderer reads `null` as a missing path, so an optional value also takes `null`, as a database row gives it.
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

// `{{ data.path }}` as text, the way the parser keeps a binding inside inline code or a code block.
const literalBinding = /\{\{\s*(data(?:\.[^\s{}]+)+)\s*\}\}/

function findBindingInCode(nodes: Node[], literal: boolean): string | undefined {
  for (const node of nodes) {
    if (typeof node === "string") {
      const match = literal ? literalBinding.exec(node) : null
      if (match) return match[1]
      continue
    }
    // Comment nodes hold no rendered text.
    if (node[0] === null) continue
    // SAFETY: Comark element tuple entries after the tag and attributes are child nodes.
    const found = findBindingInCode(node.slice(2) as Node[], literal || literalHtmlTags.has(node[0]))
    if (found) return found
  }
  return undefined
}

/**
 * Rejects a `{{ data.path }}` binding inside inline code or a code block. The renderer keeps it as text, which suits a
 * page that documents the syntax, but a template file such as an Email template expects the value there.
 */
export async function assertNoBindingsInCode(template: string): Promise<void> {
  const prepared = await prepareTemplate(template)
  const path = findBindingInCode((await parseMarkdown(prepared.template, parserOptions)).nodes, false)
  if (path) throw diagnostics.MARKDOWN_TEMPLATE_BINDING_IN_CODE({ path })
}
