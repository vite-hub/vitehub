import { parseMarkdown } from "comark"
import binding from "comark/plugins/binding"
import { renderMarkdown } from "comark/render"
import { escapeHtml } from "comark/utils"
import type { ElementNode, Node } from "comark"
import type { NodeHandler, NodeRenderData, State } from "comark/render"

import { resolveTemplateBinding, resolveScalarTemplateBinding, resolveScalarTemplateAttributes, snapshotTemplateData } from "./bindings.ts"
import { matchesCondition } from "./condition.ts"
import { markdownTemplateErrorDiagnostics as diagnostics } from "./error-diagnostics.ts"
import { prepareTemplate } from "./prepare.ts"
import { safeLinkDestination } from "./links.ts"
import type { RenderMarkdownTemplateInternalOptions, RenderMarkdownTemplateOptions } from "./types.ts"

const parserOptions = { autoClose: false, autoUnwrap: false, linkify: false, plugins: [binding()] }
const literalHtmlTags = new Set(["code", "pre", "script", "style", "textarea", "kbd", "samp", "var"])
const urlAttributesByTag = new Map([
  ["a", new Set(["href"])],
  ["area", new Set(["href"])],
  ["audio", new Set(["src"])],
  ["base", new Set(["href"])],
  ["blockquote", new Set(["cite"])],
  ["button", new Set(["formaction"])],
  ["del", new Set(["cite"])],
  ["embed", new Set(["src"])],
  ["form", new Set(["action"])],
  ["iframe", new Set(["src"])],
  ["img", new Set(["src"])],
  ["input", new Set(["formaction", "src"])],
  ["ins", new Set(["cite"])],
  ["link", new Set(["href"])],
  ["object", new Set(["data"])],
  ["q", new Set(["cite"])],
  ["script", new Set(["src"])],
  ["source", new Set(["src"])],
  ["track", new Set(["src"])],
  ["video", new Set(["poster", "src"])],
])
// Comark normalizes SVG image tags to img nodes.
const svgUrlAttributes = new Set(["a", "animate", "feimage", "image", "use"])

export async function renderMarkdownTemplate(template: string, options: RenderMarkdownTemplateOptions = {}): Promise<string> {
  return await renderMarkdownTemplateInternal(template, options)
}

export async function renderMarkdownTemplateInternal(template: string, options: RenderMarkdownTemplateInternalOptions = {}): Promise<string> {
  if (typeof template !== "string") {
    throw diagnostics.MARKDOWN_TEMPLATE_R0014({ message: "[vitehub] Markdown template must be a string." })
  }
  const prepared = await prepareTemplate(template)
  const parseOptions = { ...parserOptions, plugins: [...parserOptions.plugins, ...(options.plugins ?? [])] }
  const tree = await parseMarkdown(prepared.template, parseOptions)
  const data = snapshotTemplateData(options.data ?? {})
  // Comark resolves attributes before custom handlers; only our path resolver may read caller data.
  const renderData = (state: State): NodeRenderData => ({ ...state.renderData, data })
  return prepared.restore((await renderMarkdown(tree, {
    components: {
      Binding: async (node, state, parent) => state.one(resolveScalarTemplateBinding(node[1], renderData(state)), state, parent, true),
      If: async (node, state, parent) => {
        const { branches, after } = conditionalBranches(node)
        const selected = branches.find(branch => branch[0] === "else"
          || matchesCondition(branch[1], renderData(state), options.validateConditionPath))
        // SAFETY: Branches are Comark element tuples; entries after tag and attributes are child nodes.
        return await renderNodes([...(selected?.slice(2) as Node[] ?? []), ...after], state, parent)
      },
      Else: unexpectedBranch,
      ElseIf: unexpectedBranch,
      Insert: async (node, state, parent) => {
        if (!Object.hasOwn(node[1], ":markdown")) {
          throw diagnostics.MARKDOWN_TEMPLATE_R0020({ message: '[vitehub] Markdown template Insert requires a markdown prop. Use :insert{:markdown="data.summary"}.' })
        }
        const path = node[1][":markdown"]
        if (options.validateFragmentPath && (typeof path !== "string" || !path.startsWith("data.") || !options.validateFragmentPath(path.slice(5)))) {
          throw diagnostics.MARKDOWN_TEMPLATE_R0020({ message: `[vitehub] Markdown template fragment "${String(path)}" must use an allowed data path.` })
        }
        const value = resolveTemplateBinding(node[1], renderData(state), "markdown")
        if (typeof value !== "string") {
          throw diagnostics.MARKDOWN_TEMPLATE_R0020({ message: `[vitehub] Markdown template Insert markdown prop "${String(path ?? "markdown")}" must resolve to a string.` })
        }
        // Fragments are parsed without bindings and rendered without template components.
        const fragment = await parseMarkdown(value, { ...parseOptions, plugins: options.plugins ?? [] })
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
        const props = resolveScalarTemplateAttributes(node[1], renderData(state))
        const authoredHtml = node[1].$?.html === 1
        const sanitized = authoredHtml ? await sanitizeUrlAttributes("a", props, node[1]) : props
        const href = Object.hasOwn(node[1], ":href")
          ? await safeLinkDestination(resolveScalarTemplateBinding({ ":value": node[1][":href"] }, renderData(state)), String(node[1][":href"]))
          : authoredHtml ? sanitized.href : undefined
        if (href === undefined) return await state.handlers.a!(node, state, parent)
        // SAFETY: Preserve the element tag and children, replacing only its resolved attributes.
        return await state.handlers.a!([node[0], { ...sanitized, href }, ...node.slice(2)] as ElementNode, state, parent)
      },
      Html: {
        match: node => node[1].$?.html === 1,
        handler: async (node, state, parent) => {
          const [tag, attrs, ...children] = node
          const props = resolveScalarTemplateAttributes(attrs, renderData(state))
          const sanitized = await sanitizeUrlAttributes(tag, props, attrs, state.context.svg === true)
          const escaped = Object.fromEntries(Object.entries(sanitized).map(([key, value]) =>
            // doctor-disable-next-line typescript/strict/no-runtime-typeof -- String XML attributes need escaping; Comark serializes boolean and numeric attributes.
            [key, typeof value === "string" ? escapeHtml(value) : value]))
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only raw text children of block HTML need Markdown parsing; parsed nodes are rendered directly.
          const content = attrs.$?.block === 1 && !literalHtmlTags.has(tag) && children.every(child => typeof child === "string")
            ? (await parseMarkdown(children.join(""), parseOptions)).nodes
            : children
          // Preserve SVG ancestry across descendants; foreignObject children use HTML semantics.
          const revert = state.applyContext({ svg: tag.toLowerCase() === "svg" || state.context.svg === true && tag.toLowerCase() !== "foreignobject" })
          try {
            return await state.handlers.html!([tag, { ...escaped, $: attrs.$ }, ...content], state, parent)
          }
          finally {
            state.applyContext(revert)
          }
        },
      },
    },
  })).trim())
}

async function sanitizeUrlAttributes(tag: string, props: Record<string, unknown>, source: Record<string, unknown>, svgContext = false): Promise<Record<string, unknown>> {
  const sanitized = { ...props }
  for (const [key, value] of Object.entries(props)) {
    const attribute = key.toLowerCase()
    const isUrl = urlAttributesByTag.get(tag.toLowerCase())?.has(attribute)
      || (attribute === "href" || attribute === "xlink:href")
        && (svgUrlAttributes.has(tag.toLowerCase()) || tag.toLowerCase() === "img" && svgContext)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Comark attributes include booleans and numbers; only string URL values need destination validation.
    if (typeof value !== "string" || !isUrl) continue
    const binding = source[`:${key}`]
    sanitized[key] = await safeLinkDestination(value, String(binding ?? key), { decodeHtmlEntities: binding === undefined })
  }
  return sanitized
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
