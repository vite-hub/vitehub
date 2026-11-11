import { markdownCopyUrl } from "./markdown-negotiation.ts"
import { contentDocumentSummary, contentIndexedDocuments, renderMarkdownCopy } from "./sitemap.ts"

import type { AnyContentCollection } from "./collections-types.ts"
import type { ContentDocumentSummary } from "./collections-runtime.ts"
import type { DefineContentLlmsOptions } from "./sitemap.ts"

/** The files that `defineContent({ seo: { llms: true } })` serves. */
export type ContentLlmsFile = "llms.txt" | "llms-full.txt" | "sitemap.md"

export interface ContentLlmsOptions {
  /** Public origin. Defaults to `defineContent({ seo: { site } })`. */
  site?: string
  /** The file to render. Defaults to `llms.txt`. */
  file?: ContentLlmsFile
}

/** One link in `llms.txt`. */
export interface ContentLlmsLink {
  title: string
  href: string
  description?: string
}

/** One `##` section of `llms.txt`. */
export interface ContentLlmsSection {
  title: string
  description?: string
  links: readonly ContentLlmsLink[]
}

/** One page in `sitemap.md`. `path` sorts the page into a section by its first path segment. */
export interface ContentSitemapMarkdownPage {
  path: string
  title?: string
  href: string
}

const rawSectionDescription = "Every page below is available as raw markdown."

function absolute(path: string, site: string | undefined): string {
  return site ? `${site}${path}` : path
}

interface AgentDocument {
  collection: AnyContentCollection
  document: ContentDocumentSummary
  url: string
  title?: string
  description?: string
}

/** Published Markdown documents with a URL that search engines may index, in definition order. */
async function agentDocuments(collections: readonly AnyContentCollection[], site: string | undefined): Promise<AgentDocument[]> {
  const documents: AgentDocument[] = []
  for await (const { collection, document, url } of contentIndexedDocuments(collections, site)) {
    if (collection.format !== "markdown") continue
    documents.push({ collection, document, url, ...contentDocumentSummary(collection, document.data) })
  }
  return documents
}

/** Pages grouped by collection label, each group in URL order, with the home page split out. */
function sections(documents: readonly AgentDocument[]): { home?: AgentDocument, groups: Map<string, AgentDocument[]> } {
  const groups = new Map<string, AgentDocument[]>()
  let home: AgentDocument | undefined
  for (const document of documents) {
    if (document.url.replace(/\/+$/, "") === "") {
      home ??= document
      continue
    }
    const group = groups.get(document.collection.label)
    if (group) group.push(document)
    else groups.set(document.collection.label, [document])
  }
  for (const group of groups.values()) group.sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0)
  return { home, groups }
}

function llmsTitle(options: DefineContentLlmsOptions, site: string | undefined): string {
  return options.title ?? (site ? new URL(site).hostname : "Documentation")
}

/**
 * Render `llms.txt` in the llms.txt format that `nuxt-llms` writes: the title, the description as a quote, then each
 * section with its links. Blocks are separated by a blank line, and the text has no final newline.
 */
export function renderContentLlms(options: { title: string, description?: string, sections: readonly ContentLlmsSection[] }): string {
  const blocks = [`# ${options.title}`]
  if (options.description) blocks.push(`> ${options.description}`)
  for (const section of options.sections) {
    blocks.push(`## ${section.title}`)
    if (section.description) blocks.push(section.description)
    blocks.push(section.links.map(link => link.description ? `- [${link.title}](${link.href}): ${link.description}` : `- [${link.title}](${link.href})`).join("\n"))
  }
  return blocks.join("\n\n")
}

const escapeLabel = (label: string) => label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")

/**
 * Render `sitemap.md`: a Markdown list of every page, grouped by the first path segment of its URL. Pages one level
 * deep, such as `/about`, are under `Pages`.
 */
export function renderContentSitemapMarkdown(options: { title: string, host: string, pages: readonly ContentSitemapMarkdownPage[] }): string {
  const groups = new Map<string, ContentSitemapMarkdownPage[]>()
  for (const page of options.pages) {
    const parts = page.path.split("/").filter(Boolean)
    const key = parts.length < 2 ? "pages" : parts[0]!
    const group = groups.get(key)
    if (group) group.push(page)
    else groups.set(key, [page])
  }
  const lines = [
    `# ${options.title} Sitemap`,
    "",
    `> Markdown index of every page on ${options.host}. Links point at the raw markdown; append \`.md\` to any page URL (or set \`Accept: text/markdown\`) to get it from the page URL instead.`,
    "",
  ]
  for (const [key, pages] of groups) {
    lines.push(`## ${key.charAt(0).toUpperCase()}${key.slice(1).replace(/-/g, " ")}`, "")
    for (const page of pages) lines.push(`- [${escapeLabel(page.title || (page.path === "/" ? options.title : page.path))}](${page.href})`)
    lines.push("")
  }
  return lines.join("\n")
}

/** One file of `defineContent({ seo: { llms } })`, from the published Markdown documents with a URL. */
export async function contentLlmsFile(collections: readonly AnyContentCollection[], options: DefineContentLlmsOptions, site: string | undefined, file: ContentLlmsFile): Promise<string> {
  const documents = await agentDocuments(collections, site)
  const title = llmsTitle(options, site)
  const { home, groups } = sections(documents)
  if (file === "sitemap.md") {
    const ordered = [...home ? [home] : [], ...[...groups.values()].flat()]
    return renderContentSitemapMarkdown({
      title,
      host: site ? new URL(site).hostname : title,
      pages: ordered.map(document => ({ path: document.url, href: absolute(markdownCopyUrl(document.url), site), ...(document.title ? { title: document.title } : {}) })),
    })
  }
  if (file === "llms-full.txt") {
    const ordered = [...home ? [home] : [], ...[...groups.values()].flat()]
    const copies = await Promise.all(ordered.map(async ({ collection, document }) => {
      const full = await collection.get(document.id, { ref: "published", ...(document.locale === undefined ? {} : { locale: document.locale }) })
      return full ? await renderMarkdownCopy(collection, full, site) : undefined
    }))
    return copies.filter(copy => copy !== undefined).join("\n\n")
  }
  const link = (document: AgentDocument): ContentLlmsLink => ({
    title: document.title ?? document.url,
    href: absolute(markdownCopyUrl(document.url), site),
    ...(document.description ? { description: document.description } : {}),
  })
  return renderContentLlms({
    title,
    ...(options.description ? { description: options.description } : {}),
    sections: [
      ...home ? [{ title: "Overview", links: [{ title, href: absolute(markdownCopyUrl("/"), site) }] }] : [],
      { title: "Documentation Sets", links: [{ title, href: absolute("/llms-full.txt", site), ...(options.description ? { description: options.description } : {}) }] },
      ...[...groups].map(([label, group]) => ({ title: label, description: rawSectionDescription, links: group.map(link) })),
    ],
  })
}
