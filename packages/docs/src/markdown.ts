import { createMarkdownParser } from "comark/parse"
import alert from "comark/plugins/alert"
import attributes from "comark/plugins/attributes"
import components from "comark/plugins/components"
import shiki from "comark/plugins/shiki"
import taskList from "comark/plugins/task-list"
import toc from "comark/plugins/toc"
import comarkUi from "comark-ui/vue"
import css from "shiki/dist/langs/css.mjs"
import diff from "shiki/dist/langs/diff.mjs"
import html from "shiki/dist/langs/html.mjs"
import markdownLanguage from "shiki/dist/langs/markdown.mjs"
import mdc from "shiki/dist/langs/mdc.mjs"
import githubDark from "shiki/dist/themes/github-dark-default.mjs"
import githubLight from "shiki/dist/themes/github-light-default.mjs"

import type { ComarkPlugin, MarkdownDocument, Node as ComarkNode } from "comark"
import type { DocsSearchSection, DocsTocLink } from "./types.ts"

/** A page parsed on the server. The client renders `nodes` and never parses Markdown itself. */
export interface DocsDocument {
  nodes: ComarkNode[]
  toc: DocsTocLink[]
}

export interface DocsParserOptions {
  /** More Comark plugins, after the built-in ones. A plugin with a built-in name replaces it. */
  plugins?: ComarkPlugin[]
}

// Bash, JSON, JavaScript, TypeScript, Vue, and YAML are built in. Other code stays plain text.
const languages = [css, diff, html, markdownLanguage, mdc]
// Every token of the GitHub default themes is 4.5:1 or more on the code background. Comark's Material themes were 2.3:1 in light mode.
const themes = { light: githubLight, dark: githubDark }

/**
 * The blocks of comark-ui: callouts, tabs, steps, code with its toolbar, zoomable images, charts, and the rest. The
 * site's CSS styles the prose, so comark-ui's typeset is off. Chips are off too: they turn every web link into a chip
 * and fetch its favicon. A site turns them on by passing `comark-chips` in `docs.parser`.
 */
function docsBlocks() {
  return comarkUi({ typeset: false, chips: false, badge: { download: false } })
}

/**
 * Parse Markdown with components (`::name`), comark-ui's blocks, GitHub alerts, task lists, highlighted code, and a
 * heading outline. The client renders the nodes with comark-ui's components.
 */
export function createDocsParser(options: DocsParserOptions = {}): (markdown: string) => Promise<DocsDocument> {
  const extra = options.plugins ?? []
  // A later plugin with the same name wins: comark-ui's GitHub callouts replace Comark's alert plugin, and the site's
  // plugins replace both.
  const ordered = [alert(), taskList(), components(), attributes(), ...docsBlocks().plugins, shiki({ languages, themes, registerDefaultThemes: false }), toc({ depth: 3, searchDepth: 2 }), ...extra]
  const byName = new Map(ordered.map(plugin => [plugin.name, plugin]))
  const plugins = ordered.filter(plugin => byName.get(plugin.name) === plugin)
  const parse = createMarkdownParser({ plugins })

  async function examplePreviews(nodes: ComarkNode[]): Promise<ComarkNode[]> {
    const result: ComarkNode[] = []
    for (const node of nodes) {
      if (typeof node === "string" || node[0] === null) {
        result.push(node)
        continue
      }
      const [tag, props, ...children] = node
      const content = await examplePreviews(children)
      // A site's plugin can still supply its own preview and source pair.
      if (tag === "example" && !content.some(child => typeof child !== "string" && child[0] === "example-preview")) {
        const source = content.find(child => typeof child !== "string" && child[0] === "pre" && /^(md|markdown|mdc|comark)$/.test(String(child[1].language)))
        if (source && typeof source !== "string") {
          const preview = await parse(textOf(source.slice(2) as ComarkNode[]))
          content.unshift(["example-preview", {}, ...await examplePreviews(preview.nodes)])
        }
      }
      result.push([tag, props, ...content])
    }
    return result
  }

  return async (markdown) => {
    const document = await parse(markdown)
    return { nodes: unwrapListParagraphs(await examplePreviews(document.nodes)), toc: tocOf(document) }
  }
}

/**
 * A list item holds its text directly, also in a loose list with blank lines between items. The prose theme spaces
 * list items itself, and a paragraph margin inside each item doubled that space.
 */
function unwrapListParagraphs(nodes: ComarkNode[], inListItem = false): ComarkNode[] {
  return nodes.flatMap((node): ComarkNode[] => {
    if (typeof node === "string" || node[0] === null) return [node]
    const [tag, props, ...children] = node
    const unwrapped = unwrapListParagraphs(children, tag === "li")
    return inListItem && tag === "p" ? unwrapped : [[tag, props, ...unwrapped]]
  })
}

function tocOf(document: MarkdownDocument): DocsTocLink[] {
  const meta: { toc?: { links?: DocsTocLink[] } } = document.meta
  return meta.toc?.links ?? []
}

/** Blocks that only agents read. The site renders nothing for them, so search skips them too. */
const agentOnly = new Set(["agent-only"])

/** Split a page into one search entry per h2 and h3, like Nuxt UI's content search expects. */
export function docsSearchSections(path: string, title: string, nodes: ComarkNode[]): DocsSearchSection[] {
  const sections: DocsSearchSection[] = [{ id: path, title, titles: [], level: 1, content: "" }]
  const titles = [title]
  const visit = (node: ComarkNode) => {
    if (typeof node === "string") {
      sections.at(-1)!.content += node
      return
    }
    const [tag, props, ...children] = node
    if (tag === null || agentOnly.has(tag) || tag === "typeset-styles") return
    const level = /^h([23])$/.exec(tag)?.[1]
    if (level) {
      const depth = Number(level)
      titles.length = depth - 1
      const text = textOf(children)
      sections.push({ id: `${path}#${String(props.id ?? "")}`, title: text, titles: [...titles], level: depth, content: "" })
      titles[depth - 1] = text
      return
    }
    for (const child of children) visit(child)
    if (/^(p|li|pre|h4|h5|h6|td|th|blockquote)$/.test(tag)) sections.at(-1)!.content += " "
  }
  for (const node of nodes) visit(node)
  for (const section of sections) section.content = section.content.replace(/\s+/g, " ").trim()
  return sections
}

function textOf(nodes: ComarkNode[]): string {
  return nodes.map(node => typeof node === "string" ? node : node[0] === null ? "" : textOf(node.slice(2) as ComarkNode[])).join("")
}
