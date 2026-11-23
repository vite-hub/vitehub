import { parseMarkdown } from "comark"
import { renderMarkdown } from "comark/render"
import html from "comark/plugins/html"

import type { ElementNode, Node } from "comark"

const droppedTags = new Set(["head", "link", "meta", "noscript", "script", "style", "template", "title"])
const blockWrapperTags = new Set(["article", "aside", "body", "caption", "center", "col", "colgroup", "div", "figcaption", "figure", "footer", "header", "html", "main", "nav", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr"])
const inlineWrapperTags = new Set(["font", "label", "span"])
const blockTags = new Set(["blockquote", "dl", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "ol", "p", "pre", "ul"])
const namedEntities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00A0", quot: "\"" }
const textAttributes = new Map([["a", ["href", "title"]], ["img", ["src", "alt", "title"]], ["ol", ["start"]]])

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return namedEntities[lower] ?? entity
  })
}

function asBlocks(nodes: Node[]): ElementNode[] {
  const blocks: ElementNode[] = []
  let inline: Node[] = []
  const flush = () => {
    if (inline.some(node => typeof node !== "string" || node.trim())) blocks.push(["p", {}, ...inline])
    inline = []
  }
  for (const node of nodes) {
    if (typeof node !== "string" && node[0] !== null && blockTags.has(node[0])) {
      flush()
      blocks.push(node)
    }
    else inline.push(node)
  }
  flush()
  return blocks
}

function textNodes(node: Node): Node[] {
  if (typeof node === "string") return [decodeEntities(node).replace(/\s+/g, " ")]
  if (node[0] === null) return []
  const [rawTag, attrs, ...children] = node
  const tag = rawTag.toLowerCase()
  if (droppedTags.has(tag)) return []
  if (tag === "pre") return [["pre", {}, decodeEntities(children.map(child => typeof child === "string" ? child : "").join("").replace(/<[^>]*>/g, ""))]]
  const content = children.flatMap(child => textNodes(child))
  if (blockWrapperTags.has(tag)) return asBlocks(content)
  if (inlineWrapperTags.has(tag)) return content
  const props = Object.fromEntries((textAttributes.get(tag) ?? []).filter(key => Object.hasOwn(attrs, key)).map(key => [key, attrs[key]]))
  return [[tag, props, ...content]]
}

/**
 * The plain text fallback of an HTML email, written as Markdown: the same text format as a Markdown template. Layout
 * wrappers such as `div` and `table` are unwrapped, and `head`, `style`, and `script` are left out.
 */
export async function htmlToMarkdownText(source: string): Promise<string> {
  const tree = await parseMarkdown(source, { autoClose: false, autoUnwrap: false, plugins: [html({ markdown: false })] })
  const nodes = asBlocks(tree.nodes.flatMap(node => textNodes(node)))
  return (await renderMarkdown({ ...tree, nodes })).trim()
}
