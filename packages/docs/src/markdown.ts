import { renderHtmlFromDocument } from "@comark/html"
import { createMarkdownParser, parseFrontmatter } from "comark/parse"
import { textContent } from "comark/utils"
import alert from "comark/plugins/alert"
import attributes from "comark/plugins/attributes"
import components from "comark/plugins/components"
import shiki from "comark/plugins/shiki"
import taskList from "comark/plugins/task-list"
import toc from "comark/plugins/toc"
import comarkUiHtml from "comark-ui/html"
import comarkUi from "comark-ui/vue"
import { defu } from "defu"
import css from "shiki/dist/langs/css.mjs"
import diff from "shiki/dist/langs/diff.mjs"
import html from "shiki/dist/langs/html.mjs"
import markdownLanguage from "shiki/dist/langs/markdown.mjs"
import mdc from "shiki/dist/langs/mdc.mjs"
import githubDark from "shiki/dist/themes/github-dark-default.mjs"
import githubLight from "shiki/dist/themes/github-light-default.mjs"
import { ELEMENT_NODE, parse as parseHtml, walkSync } from "ultrahtml"

import type { ComarkPlugin, ElementNode, MarkdownDocument, Node as ComarkNode, ParserOptions } from "comark"
import type { PresetOptions } from "comark-ui/vue"
import type { DocsSearchSection, DocsTocLink } from "./types.ts"

/** A page parsed on the server. The client renders `nodes` and never parses Markdown itself. */
export interface DocsDocument {
  nodes: ComarkNode[]
  toc: DocsTocLink[]
}

export interface DocsParserOptions {
  /**
   * comark-ui's preset options, merged over the built-in ones: `{ typeset: false, chips: false, diagrams: false,
   * badge: { download: false } }`. Such as `{ chips: true }` or `{ github: { references: { repo: "owner/name" } } }`.
   * `diagrams: true` draws D2, PlantUML, and Graphviz fences through kroki.io, which receives their source. Set
   * `diagrams: { server }` to use your own Kroki server.
   */
  comarkUi?: PresetOptions
  /** Blocks that show their first fenced block rendered, next to its source. */
  examples?: DocsExamplesOptions | Record<string, string>
  /** Named Vue example sources supplied by the framework integration. */
  exampleSources?: Record<string, string>
  /** More Comark plugins, after the built-in ones. A plugin with a built-in name replaces it. */
  plugins?: ParserOptions["plugins"]
}

export interface DocsExamplesOptions {
  /** Tags of the blocks that get a preview of their first fenced block. `["example", "correct", "incorrect"]` by default. */
  tags?: string[]
  /** A playground URL for a block's Markdown, written as its `play`. `undefined` writes none. */
  play?: (source: string, tag: string) => string | undefined | Promise<string | undefined>
}

// Bash, JSON, JavaScript, TypeScript, Vue, and YAML are built in. Other code stays plain text.
const languages = [css, diff, html, markdownLanguage, mdc]
// Every token of the GitHub default themes is 4.5:1 or more on the code background. Comark's Material themes were 2.3:1 in light mode.
const themes = { light: githubLight, dark: githubDark }

/**
 * The blocks of comark-ui: callouts, tabs, steps, code with its toolbar, zoomable images, charts, Mermaid diagrams,
 * and the rest. The site's CSS styles the prose, so comark-ui's typeset is off. Chips are off too: they turn every web
 * link into a chip and fetch its favicon. A site turns them on with `comarkUi: { chips: true }`. Kroki diagrams are
 * off: they send each D2, PlantUML, or Graphviz fence to kroki.io while the page parses. Mermaid stays on, since
 * comark-pele draws it in the process.
 *
 * The plugins are the HTML preset's, so annotate, comments, diff, and quiz parse too, with the Vue preset's copy of
 * every plugin the two share.
 */
function docsBlocks(options: PresetOptions = {}) {
  const merged = defu(options, { typeset: false, chips: false, diagrams: false, badge: { download: false } }) as PresetOptions
  // Keep the plugin's authored-SVG rejection when remote drawing is off, without changing explicit opt-ins.
  if (merged.diagrams === false) merged.diagrams = { draw: false }
  const vue = new Map(comarkUi(merged).plugins.map(plugin => [plugin.name, plugin]))
  return comarkUiHtml(merged).plugins.map(plugin => vue.get(plugin.name) ?? plugin)
}

// annotate, comments, diff, and quiz have only an HTML renderer, so the server draws their blocks as HTML. Vue
// components are named in PascalCase, `Tabs` for `tabs`, and a plain element such as `span` renders in Vue as it is.
const htmlBlocks = comarkUiHtml().components
const tagKey = (tag: string) => tag.replaceAll("-", "").toLowerCase()
const vueBlocks = comarkUi()
const vueTags = new Set([...Object.keys(vueBlocks.components), ...vueBlocks.tags].map(tagKey))
const htmlOnly = new Set(Object.keys(htmlBlocks).filter(tag => !vueTags.has(tagKey(tag))))

const isElement = (node: ComarkNode): node is ElementNode => Array.isArray(node) && typeof node[0] === "string"
// A block such as `:suggestion` can sit in a paragraph, where a `div` would end the paragraph in the browser.
const phrasing = /^(?:p|h[1-6]|a|span|em|strong|del|s|mark|sup|sub|small|label)$/

/** Draw the page's HTML-only blocks in one context, so styles, fonts, and scripts are emitted once. */
async function renderHtmlBlocks(nodes: ComarkNode[]): Promise<void> {
  const blocks = new Map<ElementNode, ElementNode>()
  const roots: ElementNode[] = []
  const visit = (nodes: ComarkNode[], from = 0, parent?: string, insideHtml = false) => {
    for (let at = from; at < nodes.length; at++) {
      const node = nodes[at]!
      if (!isElement(node)) continue
      const tag = node[0]
      visit(node as ComarkNode[], 2, tag, insideHtml || htmlOnly.has(tag))
      if (htmlOnly.has(tag)) {
        // Keep the source props and children for app overrides, search, and heading text.
        const rendered: ElementNode = ["comark-html", { block: tag, blockProps: node[1], ...(parent && phrasing.test(parent) ? { inline: true } : {}) }, ...node.slice(2) as ComarkNode[]]
        blocks.set(rendered, node)
        if (!insideHtml) roots.push(rendered)
        nodes[at] = rendered
      }
    }
  }
  visit(nodes)
  if (!blocks.size) return
  let assets = ""
  await renderHtmlFromDocument({ nodes: roots }, {
    components: {
      ...htmlBlocks,
      "comark-html": async (node, state) => {
        let html = (await state.render([blocks.get(node)!])).trim()
        const ranges: Array<[number, number]> = []
        walkSync(parseHtml(html), (element) => {
          if (element.type !== ELEMENT_NODE || !/^(style|script|link)$/.test(element.name)) return
          const start = element.loc[0].start
          const end = element.loc[1].end
          assets += html.slice(start, end)
          ranges.push([start, end])
        })
        for (const [start, end] of ranges.reverse()) html = html.slice(0, start) + html.slice(end)
        node[1].html = html
        return html
      },
    },
  })
  // An app can replace the first block that emitted shared assets. Keep them independent of every block override.
  if (assets) nodes.push(["comark-html", { html: assets, inline: true }])
}

/**
 * Parse Markdown with components (`::name`), comark-ui's blocks, GitHub alerts, task lists, highlighted code, and a
 * heading outline. The client renders the nodes with comark-ui's components.
 */
export function createDocsParser(options: DocsParserOptions = {}): (markdown: string) => Promise<DocsDocument> {
  const extra = options.plugins ?? []
  const configured = options.examples ?? {}
  const isSources = (value: DocsExamplesOptions | Record<string, string>): value is Record<string, string> => Object.values(value).every(source => typeof source === "string")
  const settings = isSources(configured) ? {} : configured
  const sources = { ...options.exampleSources, ...(isSources(configured) ? configured : {}) }
  const examplePlugin = examples(markdown => parseDocument(markdown), sources, settings)
  // A later plugin with the same name wins: comark-ui's GitHub callouts replace Comark's alert plugin, and the site's
  // plugins replace both.
  const ordered = [alert(), taskList(), components(), attributes(), ...docsBlocks(options.comarkUi), shiki({ languages, themes, registerDefaultThemes: false }), toc({ depth: 3, searchDepth: 2 }), examplePlugin, ...extra]
  const byName = new Map(ordered.map(plugin => [plugin.name, plugin]))
  // Generate default previews after site plugins have had a chance to supply their own.
  const plugins = ordered.filter(plugin => byName.get(plugin.name) === plugin && plugin !== examplePlugin)
  if (byName.get(examplePlugin.name) === examplePlugin) plugins.push(examplePlugin)
  const parse = createMarkdownParser({ plugins })
  const parseDocument = async (markdown: string): Promise<DocsDocument> => {
    const document = await parse(markdown)
    return { nodes: document.nodes, toc: tocOf(document) }
  }
  return async (markdown) => {
    const document = await parseDocument(markdown)
    const nodes = isolateExampleHeadings(unwrapListParagraphs(document.nodes))
    await renderHtmlBlocks(nodes)
    return { ...document, nodes }
  }
}

const markdownLanguages = new Set(["md", "markdown", "mdc", "comark"])
/** `::correct` and `::incorrect` are examples with a title. */
const defaultExampleTags = ["example", "correct", "incorrect"]

/**
 * `::example` shows a preview and its source, a switch apart. Around a Markdown code block, the preview is that
 * Markdown, parsed here with the page's own plugins. With `name`, it is the Vue file of that name in the examples
 * folder, and its source becomes the code block. Either way the page reaches the browser as nodes.
 */
function examples(parse: (markdown: string) => Promise<DocsDocument>, sources: Record<string, string>, options: DocsExamplesOptions): ComarkPlugin {
  const exampleTags = new Set(options.tags ?? defaultExampleTags)
  const visit = async (nodes: ComarkNode[]): Promise<void> => {
    for (const node of nodes) {
      if (typeof node === "string" || node[0] === null) continue
      // SAFETY: an element node is [tag, attributes, ...children].
      const children = node.slice(2) as ComarkNode[]
      if (!exampleTags.has(node[0])) {
        await visit(children)
        continue
      }
      const name = typeof node[1].name === "string" ? node[1].name : undefined
      if (name) {
        const source = sources[name]
        if (source === undefined) throw new Error(`::example names "${name}", but the examples folder has no ${name}.vue.`)
        // A fence longer than any run of backticks in the file keeps the file whole.
        const fence = "`".repeat(Math.max(3, ...[...source.matchAll(/`+/g)].map(run => run[0].length + 1)))
        const { nodes: code } = await parse(`${fence}vue\n${source.trim()}\n${fence}\n`)
        node.splice(2, node.length, ...code)
        continue
      }
      if (children.some(child => typeof child !== "string" && child[0] === "example-preview")) continue
      const pre = children.find((child): child is Extract<ComarkNode, unknown[]> => typeof child !== "string" && child[0] === "pre")
      const language = pre && typeof pre[1].language === "string" ? pre[1].language : ""
      if (!pre || !markdownLanguages.has(language)) continue
      const markdown = typeof pre[1].code === "string" ? pre[1].code : textContent(pre)
      const url = await options.play?.(markdown, node[0])
      if (url !== undefined) node[1].play = url
      // Invalid frontmatter can be deliberate. Check its syntax alone so missing examples and plugin errors still
      // report their original diagnostics from the full preview parser.
      try {
        parseFrontmatter(markdown)
      } catch {
        continue
      }
      const preview = await parse(markdown)
      node.splice(2, 0, ["example-preview", {}, ...preview.nodes])
    }
  }
  return { name: "docs-examples", post: state => visit(state.tree.nodes) }
}

/** Preview anchors belong to their own document, including links to headings in that preview. */
function isolateExampleHeadings(nodes: ComarkNode[]): ComarkNode[] {
  const used = new Set<string>()
  const walk = (nodes: ComarkNode[], visit: (node: Extract<ComarkNode, unknown[]>) => void, skipPreviews = false) => {
    for (const node of nodes) {
      if (typeof node === "string" || node[0] === null || (skipPreviews && node[0] === "example-preview")) continue
      visit(node)
      walk(node.slice(2) as ComarkNode[], visit, skipPreviews)
    }
  }
  walk(nodes, node => { if (typeof node[1].id === "string") used.add(node[1].id) })
  let preview = 0
  const rewrite = (nodes: ComarkNode[], anchors = new Map<string, string>()): ComarkNode[] => nodes.map((node) => {
    if (typeof node === "string" || node[0] === null) return node
    const [tag, props, ...children] = node
    const scope = tag === "example-preview" ? new Map<string, string>() : anchors
    if (tag === "example-preview") {
      const prefix = `docs-example-${++preview}-`
      walk(children, ([heading, props]) => {
        if (heading === null || !/^h[1-6]$/.test(heading) || typeof props.id !== "string") return
        let id = `${prefix}${props.id}`
        while (used.has(id)) id += "-preview"
        used.add(id)
        scope.set(props.id, id)
      }, true)
    }
    const id = /^h[1-6]$/.test(tag) && typeof props.id === "string" ? scope.get(props.id) : undefined
    const href = tag === "a" && typeof props.href === "string" && props.href.startsWith("#") ? scope.get(props.href.slice(1)) : undefined
    return [tag, { ...props, ...(id ? { id } : {}), ...(href ? { href: `#${href}` } : {}) }, ...rewrite(children, scope)]
  })
  return rewrite(nodes)
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
/** An example's preview repeats its source, which search already reads in the code block. */
const repeated = new Set(["example-preview"])

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
    if (tag === null || agentOnly.has(tag) || repeated.has(tag) || tag === "typeset-styles") return
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
