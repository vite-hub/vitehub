import { markdownCopyUrl as copyUrl } from "./markdown-negotiation.ts"
import type { DefineContentLlmsOptions } from "./sitemap.ts"

/** The files that `defineContent({ seo: { llms: true } })` serves. */
export type ContentLlmsFile = "llms.txt" | "llms-full.txt" | "sitemap.md"

export interface ContentLlmsOptions {
  /** Public origin. Defaults to `defineContent({ seo: { site } })`. */
  site?: string
  /** The file to render. Defaults to `llms.txt`. */
  file?: ContentLlmsFile
  /**
   * The translated locale of `llms-full.txt`, such as `es` for `/es/llms-full.txt`. Another value, or none, gives the
   * file of the source locale.
   */
  locale?: string
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
  /** The locale of the page, in a collection with `locales`. */
  locale?: string
}

/** What a `sections` function of `defineContent({ seo: { llms } })` gets. */
export interface ContentLlmsSectionsContext {
  /** The pages of `llms.txt`, in the order of the file. */
  pages: readonly ContentLlmsPage[]
  /** The Markdown copy of one of `pages`, as `llms-full.txt` has it, or null. */
  markdown: (page: ContentLlmsPage) => Promise<string | null>
}

/** A page of the llms files. `translation` is its locale when that is not the source locale of its collection. */
export type ContentLlmsFilePage = ContentLlmsPage & { translation?: string }

/** Pages grouped by section, with the home page split out. Without an app order, each group is in URL order. */
function sections<TPage extends ContentLlmsPage>(pages: readonly TPage[], urlOrder: boolean): { home?: TPage, groups: Map<string, TPage[]> } {
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
  if (urlOrder) for (const group of groups.values()) group.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
  return { home, groups }
}

function llmsTitle(options: DefineContentLlmsOptions, site: string | undefined): string {
  return options.title ?? (site ? new URL(site).hostname : "Documentation")
}

const escapeLabel = (label: string) => label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]")
const singleLine = (text: string) => text.trim().replace(/\s*\n\s*/g, " ")
const quote = (text: string) => text.trim().split("\n").map(line => line.trim() ? `> ${line.trim()}` : ">").join("\n")

/**
 * The head of `llms.txt` and `llms-full.txt`: the title, the description as a quote, and the details. Every line of the
 * description is in the quote.
 */
function llmsHead(options: { title: string, description?: string, details?: string }): string[] {
  return [`# ${singleLine(options.title)}`, ...options.description?.trim() ? [quote(options.description)] : [], ...options.details?.trim() ? [options.details.trim()] : []]
}

/**
 * Render `llms.txt` in the llms.txt format that `nuxt-llms` writes: the title, the description as a quote, the details,
 * then each section with its links. Link titles are escaped and link descriptions are one line. Blocks are separated by
 * a blank line, and the text has no final newline.
 */
export function renderContentLlms(options: { title: string, description?: string, details?: string, sections: readonly ContentLlmsSection[] }): string {
  const blocks = llmsHead(options)
  for (const section of options.sections) {
    blocks.push(`## ${singleLine(section.title)}`)
    if (section.description) blocks.push(section.description)
    blocks.push(section.links.map((link) => {
      const item = `- [${escapeLabel(singleLine(link.title))}](${link.href})`
      return link.description?.trim() ? `${item}: ${singleLine(link.description)}` : item
    }).join("\n"))
  }
  return blocks.join("\n\n")
}

/**
 * Render `llms-full.txt`: the head of `llms.txt`, then the copy of each page after the URL of the page, so an agent can
 * cite it. A line with `---` separates the pages. A copy without a heading starts with the page title.
 */
export function renderContentLlmsFull(options: { title: string, description?: string, details?: string, pages: readonly { url: string, title: string, markdown: string }[] }): string {
  const pages = options.pages.map((page) => {
    const markdown = page.markdown.trim()
    return [`URL: ${page.url}`, ...markdown.startsWith("#") ? [] : [`# ${singleLine(page.title)}`], ...markdown ? [markdown] : []].join("\n\n")
  })
  return `${[llmsHead(options).join("\n\n"), ...pages].join("\n\n---\n\n")}\n`
}

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
 * Markdown copy of one page for `llms-full.txt`. `llms-full.txt` holds the pages of one locale: `locale` when a page
 * is a translation in it, else the source locale.
 */
export async function contentLlmsFile<TPage extends ContentLlmsFilePage>(pages: readonly TPage[], copy: (page: TPage) => Promise<string | null>, options: DefineContentLlmsOptions, site: string | undefined, file: ContentLlmsFile, prefix = "", locale?: string): Promise<string> {
  const title = llmsTitle(options, site)
  const markdownCopyUrl = (path: string) => copyUrl(path, prefix)
  const { home, groups } = sections(options.sort ? [...pages].sort(options.sort) : pages, !options.sort)
  const ordered = [...home ? [home] : [], ...[...groups.values()].flat()]
  const translations = [...new Set(ordered.flatMap(page => page.translation === undefined ? [] : [page.translation]))].sort()
  if (file === "sitemap.md") {
    return renderContentSitemapMarkdown({
      title,
      host: site ? new URL(site).hostname : title,
      pages: ordered.map(page => ({ path: page.path, href: absolute(markdownCopyUrl(page.path), site), ...(page.title ? { title: page.title } : {}) })),
    })
  }
  const head = { title, ...(options.description ? { description: options.description } : {}), ...(options.details ? { details: options.details } : {}) }
  if (file === "llms-full.txt") {
    const fileLocale = locale !== undefined && translations.includes(locale) ? locale : undefined
    const filePages = ordered.filter(page => page.translation === fileLocale)
    const copies = await Promise.all(filePages.map(copy))
    return renderContentLlmsFull({
      ...head,
      ...fileLocale === undefined ? {} : options.locales?.[fileLocale],
      pages: filePages.flatMap((page, index) => {
        const markdown = copies[index]
        return markdown === null || markdown === undefined ? [] : [{ url: absolute(page.path, site), title: page.title ?? page.path, markdown }]
      }),
    })
  }
  const link = (page: TPage): ContentLlmsLink => ({
    title: page.title ?? page.path,
    href: absolute(markdownCopyUrl(page.path), site),
    ...(page.description ? { description: page.description } : {}),
  })
  const extra = typeof options.sections === "function"
    ? await options.sections({
        pages: ordered,
        markdown: async (page) => {
          const own = ordered.find(candidate => candidate === page)
          return own ? await copy(own) : null
        },
      })
    : options.sections ?? []
  const set = (fileLocale?: string): ContentLlmsLink => {
    const localized = fileLocale === undefined ? undefined : options.locales?.[fileLocale]
    const description = localized?.description ?? options.description
    return {
      title: localized?.title ?? (fileLocale === undefined ? title : `${title} (${fileLocale})`),
      href: absolute(fileLocale === undefined ? "/llms-full.txt" : `/${fileLocale}/llms-full.txt`, site),
      ...description ? { description } : {},
    }
  }
  return renderContentLlms({
    ...head,
    sections: [
      ...home ? [{ title: "Overview", links: [{ title, href: absolute(markdownCopyUrl("/"), site) }] }] : [],
      { title: "Documentation Sets", links: [set(), ...translations.map(set)] },
      ...extra,
      ...[...groups].map(([label, group]) => ({ title: label, description: rawSectionDescription, links: group.map(link) })),
    ],
  })
}
