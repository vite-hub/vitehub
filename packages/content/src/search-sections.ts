import type { Node as ComarkNode } from "comark"

/** One part of a document for a search index: the document itself, or one heading and the text under it. */
export interface ContentSearchSection {
  /** The document path, plus `#<heading id>` for a heading. */
  id: string
  /** The document title, or the heading text. */
  title: string
  /** The headings above this part, from the document title down. Empty for the document itself. */
  titles: string[]
  /** 1 for the document, else the heading level. */
  level: number
  /** The text of this part, without its headings. The document's part holds the text before its first heading. */
  content: string
}

/** A part from `content.searchSections()`, with its document's Source name and Content key. */
export interface ContentSourceSearchSection extends ContentSearchSection {
  source: string
  key: string
}

export interface ContentSearchSectionsOptions {
  /** Heading levels that start a part. Defaults to `[2, 3]`, the levels of a page outline. */
  headings?: readonly number[]
  /** Tags whose text search skips, such as blocks that only agents read. */
  ignore?: readonly string[]
}

/** Blocks after which the text of the next block starts a new word. */
const blocks = /^(p|li|pre|h[1-6]|td|th|blockquote)$/

/**
 * Split a parsed document into one part per heading. Headings inside components count too, such as a heading in a
 * tab, and the text of each block ends with a space, so two list items do not join into one word.
 */
export function contentSearchSections(
  document: { path: string, title: string, nodes: readonly ComarkNode[] },
  options: ContentSearchSectionsOptions = {},
): ContentSearchSection[] {
  // A heading's depth is its place among the levels, so `[2, 4]` puts an h4 right under an h2.
  const depths = [...new Set(options.headings ?? [2, 3])].sort((left, right) => left - right)
  const ignore = new Set(options.ignore)
  const sections: ContentSearchSection[] = [{ id: document.path, title: document.title, titles: [], level: 1, content: "" }]
  // The title of each heading level above the current part, from the document title down.
  const titles = [document.title]
  const visit = (node: ComarkNode) => {
    if (typeof node === "string") {
      sections.at(-1)!.content += node
      return
    }
    const [tag, props, ...children] = node
    if (tag === null || ignore.has(tag)) return
    const level = Number(/^h([1-6])$/.exec(tag)?.[1] ?? 0)
    const depth = depths.indexOf(level) + 1
    if (depth) {
      const text = textOf(children)
      titles.length = depth
      sections.push({ id: `${document.path}#${String(props.id ?? "")}`, title: text, titles: [...titles], level, content: "" })
      titles[depth] = text
      return
    }
    for (const child of children) visit(child)
    if (blocks.test(tag)) sections.at(-1)!.content += " "
  }
  for (const node of document.nodes) visit(node)
  for (const section of sections) section.content = section.content.replace(/\s+/g, " ").trim()
  return sections
}

function textOf(nodes: readonly ComarkNode[]): string {
  return nodes.map(node => typeof node === "string" ? node : node[0] === null ? "" : textOf(node.slice(2) as ComarkNode[])).join("")
}
