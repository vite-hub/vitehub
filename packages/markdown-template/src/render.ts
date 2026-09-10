import { parseMarkdown } from "comark"
import binding from "comark/plugins/binding"
import { renderMarkdown, resolveAttributes } from "comark/render"
import { escapeHtml } from "comark/utils"
import type { ElementNode, Node } from "comark"
import type { NodeHandler, State } from "comark/render"

import { matchesCondition } from "./condition.ts"
import { markdownTemplateErrorDiagnostics as diagnostics } from "./error-diagnostics.ts"
import { prepareTemplate } from "./prepare.ts"
import { safeLinkDestination } from "./links.ts"
import type { RenderMarkdownTemplateInternalOptions, RenderMarkdownTemplateOptions } from "./types.ts"

const parserOptions = { autoClose: false, autoUnwrap: false, linkify: false, plugins: [binding()] }
const literalHtmlTags = new Set(["code", "pre", "script", "style", "textarea", "kbd", "samp", "var"])

export async function renderMarkdownTemplate(template: string, options: RenderMarkdownTemplateOptions = {}): Promise<string> {
  return await renderMarkdownTemplateInternal(template, options)
}

export async function renderMarkdownTemplateInternal(template: string, options: RenderMarkdownTemplateInternalOptions = {}): Promise<string> {
  if (typeof template !== "string") {
    throw diagnostics.MARKDOWN_TEMPLATE_R0014({ message: "[vitehub] Markdown template must be a string." })
  }
  const prepared = await prepareTemplate(template)
  const tree = await parseMarkdown(prepared.template, parserOptions)
  return prepared.restore((await renderMarkdown(tree, {
    data: ownData(options.data ?? {}),
    components: {
      Binding: async (node, state, parent) => state.one(scalarValue(node, state), state, parent, true),
      If: async (node, state, parent) => {
        const { branches, after } = conditionalBranches(node)
        const selected = branches.find(branch => branch[0] === "else"
          || matchesCondition(branch[1], state.renderData, options.validateConditionPath))
        // SAFETY: Branches are Comark element tuples; entries after tag and attributes are child nodes.
        return await renderNodes([...(selected?.slice(2) as Node[] ?? []), ...after], state, parent)
      },
      Else: unexpectedBranch,
      ElseIf: unexpectedBranch,
      Insert: async (node, state, parent) => {
        if (!Object.hasOwn(node[1], ":markdown") && !Object.hasOwn(node[1], "markdown")) {
          throw diagnostics.MARKDOWN_TEMPLATE_R0020({ message: '[vitehub] Markdown template Insert requires a markdown prop. Use :insert{:markdown="data.summary"}.' })
        }
        const path = node[1][":markdown"]
        if (options.validateFragmentPath && (typeof path !== "string" || !path.startsWith("data.") || !options.validateFragmentPath(path.slice(5)))) {
          throw diagnostics.MARKDOWN_TEMPLATE_R0020({ message: `[vitehub] Markdown template fragment "${String(path)}" must use an allowed data path.` })
        }
        const value = boundValue(node, state, "markdown")
        if (typeof value !== "string") {
          throw diagnostics.MARKDOWN_TEMPLATE_R0020({ message: `[vitehub] Markdown template Insert markdown prop "${String(path ?? "markdown")}" must resolve to a string.` })
        }
        // Fragments are parsed without bindings and rendered without template components.
        const fragment = await parseMarkdown(value, { autoClose: false, autoUnwrap: false, linkify: false })
        if (parent && (parent[0] === "p" || state.context.inline)) {
          if (!fragment.nodes.length) return ""
          if (fragment.nodes.length !== 1 || !Array.isArray(fragment.nodes[0]) || fragment.nodes[0][0] !== "p") {
            throw diagnostics.MARKDOWN_TEMPLATE_R0021({ message: "[vitehub] Markdown template fragment cannot contain block Markdown when used inline. Put :insert on its own line, separated by blank lines." })
          }
          // SAFETY: The check above establishes a paragraph element whose remaining tuple entries are child nodes.
          return await renderNodes(fragment.nodes[0].slice(2) as Node[], literalState(state), parent)
        }
        return await renderNodes(fragment.nodes, literalState(state), parent)
      },
      A: async (node, state, parent) => {
        if (!Object.hasOwn(node[1], ":href")) return await state.handlers.a!(node, state, parent)
        const props = resolveAttributes(node[1], state.renderData, { parseJson: true })
        const bound = resolveAttributes({ ":value": node[1][":href"] }, state.renderData, { parseJson: true })
        const href = await safeLinkDestination(requireScalar(bound.value, String(node[1][":href"])), String(node[1][":href"]))
        // SAFETY: Preserve the element tag and children, replacing only its resolved attributes.
        return await state.handlers.a!([node[0], { ...props, href }, ...node.slice(2)] as ElementNode, state, parent)
      },
      Html: {
        match: node => node[1].$?.html === 1 && !literalHtmlTags.has(node[0]),
        handler: async (node, state, parent) => {
          const [tag, attrs, ...children] = node
          const props = resolveAttributes(attrs, state.renderData, { parseJson: true })
          for (const key of Object.keys(attrs)) {
            if (key.startsWith(":")) requireScalar(props[key.slice(1)], String(attrs[key]))
          }
          const escaped = Object.fromEntries(Object.entries(props).map(([key, value]) =>
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- String XML attributes need escaping; Comark serializes boolean and numeric attributes.
            [key, typeof value === "string" ? escapeHtml(value) : value]))
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only raw text children of block HTML need Markdown parsing; parsed nodes are rendered directly.
          const content = attrs.$?.block === 1 && children.every(child => typeof child === "string")
            ? (await parseMarkdown(children.join(""), parserOptions)).nodes
            : children
          return await state.handlers.html!([tag, { ...escaped, $: attrs.$ }, ...content], state, parent)
        },
      },
    },
  })).trim())
}

function boundValue(node: ElementNode, state: State, prop = "value"): unknown {
  const props = resolveAttributes(node[1], state.renderData, { parseJson: true })
  if (props[prop] === undefined || props[prop] === null) {
    throw diagnostics.MARKDOWN_TEMPLATE_R0017({ message: `[vitehub] Markdown template binding "${String(node[1][`:${prop}`] ?? prop)}" is not defined.` })
  }
  return props[prop]
}

function scalarValue(node: ElementNode, state: State): string {
  return requireScalar(boundValue(node, state), String(node[1][":value"] ?? "value"))
}

function requireScalar(value: unknown, path: string): string {
  if (value === undefined || value === null) {
    throw diagnostics.MARKDOWN_TEMPLATE_R0017({ message: `[vitehub] Markdown template binding "${path}" is not defined.` })
  }
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- This binding boundary accepts exactly the three scalar representations and rejects objects.
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  throw diagnostics.MARKDOWN_TEMPLATE_R0018({ message: `[vitehub] Markdown template binding "${path}" must resolve to a scalar value.` })
}

function literalState(state: State): State {
  return { ...state, context: { ...state.context, handlers: {}, conditionalHandlers: [] } }
}

async function renderNodes(nodes: Node[], state: State, parent?: ElementNode): Promise<string> {
  let rendered = ""
  for (const node of nodes) rendered += await state.one(node, state, parent, !rendered || rendered.endsWith("\n"))
  return rendered
}

const unexpectedBranch: NodeHandler = (node) => {
  throw diagnostics.MARKDOWN_TEMPLATE_R0015({ message: `[vitehub] Markdown template ${node[0]} block must follow an if block.` })
}

function conditionalBranches(node: ElementNode): { branches: ElementNode[], after: Node[] } {
  const branches: ElementNode[] = []
  const after: Node[] = []
  const visit = ([tag, attrs, ...children]: ElementNode) => {
    if (tag === "else" && Object.keys(attrs).length) {
      throw diagnostics.MARKDOWN_TEMPLATE_R0022({ message: "[vitehub] Markdown template else block does not accept a condition." })
    }
    const branch: ElementNode = [tag, attrs]
    branches.push(branch)
    let hasNextBranch = false
    for (const child of children) {
      if (Array.isArray(child) && (child[0] === "else-if" || child[0] === "else")) {
        if (branches.at(-1)?.[0] === "else") {
          throw diagnostics.MARKDOWN_TEMPLATE_R0023({ message: "[vitehub] Markdown template else block cannot be followed by another branch." })
        }
        visit(child)
        hasNextBranch = true
      }
      else if (hasNextBranch) after.push(child)
      else branch.push(child)
    }
  }
  visit(node)
  return { branches, after }
}

// Comark resolves inherited properties; expose only the explicit data for this render.
function ownData<T>(value: T, seen = new WeakMap<object, object>()): T {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Clone object properties recursively while preserving scalar values unchanged.
  if (!value || typeof value !== "object") return value
  // SAFETY: The map stores only the corresponding clone for each input object during this traversal.
  if (seen.has(value)) return seen.get(value) as T
  const copy = Object.setPrototypeOf(Array.isArray(value) ? [] : {}, null)
  seen.set(value, copy)
  for (const [key, item] of Object.entries(value)) copy[key] = ownData(item, seen)
  // SAFETY: The clone preserves own enumerable data and array shape; Comark only reads those properties.
  return copy as T
}
