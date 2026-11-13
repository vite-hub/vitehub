import { markdownCopyUrl as copyUrl } from "./markdown-negotiation.ts"
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

/** A routed Markdown page with its section in `llms.txt`. */
export interface ContentLlmsPage {
  /** The page path, such as `/blog/hello`. */
  path: string
  title?: string
  description?: string
  /** The `llms.txt` section of the page: the label of its collection. */
  section: string
}

/** Pages grouped by section, each group in URL order, with the home page split out. */
function sections<TPage extends ContentLlmsPage>(pages: readonly TPage[]): { home?: TPage, groups: Map<string, TPage[]> } {
  const groups = new Map<string, TPage[]>()
  let home: TPage | undefined
  for (const page of pages) {
    if (page.path.replace(/\/+$/, "") === "") {
      home ??= page
      continue
    }
    const group = groups.get(page.section)
    if (group) group.push(page)
    else groups.set(page.section, [page])
  }
  for (const group of groups.values()) group.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
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

/**
 * One file of `defineContent({ seo: { llms } })`, from the routed Markdown pages in definition order. `copy` reads the
 * Markdown copy of one page for `llms-full.txt`.
 */
export async function contentLlmsFile<TPage extends ContentLlmsPage>(pages: readonly TPage[], copy: (page: TPage) => Promise<string | null>, options: DefineContentLlmsOptions, site: string | undefined, file: ContentLlmsFile, prefix = ""): Promise<string> {
  const title = llmsTitle(options, site)
  const markdownCopyUrl = (path: string) => copyUrl(path, prefix)
  const { home, groups } = sections(pages)
  const ordered = [...home ? [home] : [], ...[...groups.values()].flat()]
  if (file === "sitemap.md") {
    return renderContentSitemapMarkdown({
      title,
      host: site ? new URL(site).hostname : title,
      pages: ordered.map(page => ({ path: page.path, href: absolute(markdownCopyUrl(page.path), site), ...(page.title ? { title: page.title } : {}) })),
    })
  }
  if (file === "llms-full.txt") {
    const copies = await Promise.all(ordered.map(copy))
    return copies.filter(text => text !== null).join("\n\n")
  }
  const link = (page: TPage): ContentLlmsLink => ({
    title: page.title ?? page.path,
    href: absolute(markdownCopyUrl(page.path), site),
    ...(page.description ? { description: page.description.replace(/\s*\n\s*/g, " ") } : {}),
  })
  const description = [options.description, options.details].filter(Boolean).join("\n\n")
  return renderContentLlms({
    title,
    ...(description ? { description } : {}),
    sections: [
      ...home ? [{ title: "Overview", links: [{ title, href: absolute(markdownCopyUrl("/"), site) }] }] : [],
      { title: "Documentation Sets", links: [{ title, href: absolute("/llms-full.txt", site), ...(options.description ? { description: options.description } : {}) }] },
      ...options.sections ?? [],
      ...[...groups].map(([label, group]) => ({ title: label, description: rawSectionDescription, links: group.map(link) })),
    ],
  })
}
