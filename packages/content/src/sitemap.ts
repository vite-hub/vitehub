import { parseMarkdown } from "comark/parse"
import type { ComarkPlugin } from "comark"
import type { LeaseStore } from "@vite-hub/runtime"

import { contentDocumentUrl } from "./documents.ts"
import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { AnyContentCollection } from "./collections-types.ts"
import { titleCase } from "./title-case.ts"
import type { ContentCollectionsRuntime } from "./collections-runtime.ts"
import type { ContentDocumentUrl } from "./documents.ts"
import type { ContentMcpOptions } from "./mcp.ts"
import type { ContentSourceSeo } from "./content-source.ts"
import type { ContentLlmsSection } from "./llms.ts"

/** `defineContent({ seo })`: site-wide SEO routes generated from routable collections. */
export interface DefineContentSeoOptions {
  /**
   * Public origin, such as `https://example.com`, or the URL where the app is mounted, such as `https://example.com/docs`.
   * Defaults to the origin of each request.
   */
  site?: string
  /** Serve `/sitemap.xml` with the published documents of every collection, and the documents of every Source, that has a `url`. */
  sitemap?: boolean
  /** Serve `/robots.txt` that allows crawling and names the sitemap. `disallow` adds paths to keep out. */
  robots?: boolean | { disallow?: readonly string[] }
  /**
   * Serve each published Markdown document with a URL as Markdown at that URL plus `.md`, such as `/blog/hello.md`
   * for `/blog/hello` and `/index.md` for `/`, so agents can read it and readers can paste it into a chat. `prefix`
   * also serves each copy below a folder, such as `/raw/blog/hello.md`, and the llms files link there.
   */
  markdown?: boolean | ContentMarkdownOptions
  /**
   * Serve `/rss.xml`, an RSS 2.0 feed of the published Markdown pages that the sitemap lists, newest first by the date
   * of their latest `content.history()` entry. `title` defaults to the host name, `limit` to 20 items, at most 500.
   */
  rss?: boolean | ContentRssOptions
  /**
   * Serve a public read-only MCP server at `/mcp` with two tools: `list-pages` lists the published Markdown pages that
   * the sitemap lists, and `get-page` reads one of them as Markdown. `name` is the server name, the host name by default.
   */
  mcp?: boolean | ContentMcpOptions
  /**
   * Serve `/llms.txt`, `/llms-full.txt`, and `/sitemap.md` from the published Markdown documents with a URL. Their links
   * point at the `.md` copies, so this also turns on `markdown`. `title` and `description` head `llms.txt`; the title
   * defaults to the site host name.
   */
  llms?: boolean | DefineContentLlmsOptions
  /**
   * Atomic leases for Source date refreshes across server instances. Use a shared LeaseStore, such as
   * `createSqlLeaseStore()` from `@vite-hub/runtime`. Without it, work is shared only within this Content instance.
   * Cloudflare KV cannot provide these leases. A held lease serves cached dates until a later read sees the new set.
   */
  dateLeases?: LeaseStore
}

/** `defineContent({ seo: { rss } })`. */
export interface ContentRssOptions {
  /** The feed title. Defaults to the host name of the site. */
  title?: string
  /** The feed description. Defaults to the title. */
  description?: string
  /** The newest pages to list, default 20, at most 500. */
  limit?: number
}

/** `defineContent({ seo: { markdown } })`. */
export interface ContentMarkdownOptions {
  /** A folder that also serves each copy, such as `/raw` for `/raw/blog/hello.md`. The llms files link there. */
  prefix?: string
}

/** `defineContent({ seo: { llms } })`. */
export interface DefineContentLlmsOptions {
  /** The heading of `llms.txt` and `sitemap.md`, such as `ViteHub`. Defaults to the host name of the site. */
  title?: string
  /** The summary under the `llms.txt` heading. */
  description?: string
  /** Text under the summary, such as rules for agents. The `llms-full.txt` link keeps the summary only. */
  details?: string
  /** More sections, after the `llms-full.txt` link and before the sections of pages. */
  sections?: readonly ContentLlmsSection[]
}

export interface ContentSitemapEntry {
  collection: string
  id: string
  /** Absolute URL when a site is known, otherwise the document path. */
  loc: string
  /** The locale of the page, in a collection with `locales`. */
  locale?: string
  /** When the published document last changed, as an ISO timestamp. */
  lastmod?: string
}

export interface ContentSitemapOptions {
  /** Public origin. Defaults to `defineContent({ seo: { site } })`. */
  site?: string
  /**
   * The `waitUntil` of the request, such as `getStandardContext(request).waitUntil`. After a `github()` Source head
   * moves, the answer then uses the page dates of the previous head at once, and Content computes the new dates after
   * the response. Without it, the first answer after a head move waits for GitHub.
   * When another instance holds `seo.dateLeases`, either form serves cached dates until the new set is visible.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}

/** One sitemap file holds at most this many URLs. */
export const contentSitemapLimit = 50_000

export function normalizeSeoOptions(options: unknown): DefineContentSeoOptions | undefined {
  if (options === undefined) return
  const invalid = (message: string) => contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] defineContent({ seo }) ${message}` })
  if (options === null || Object(options) !== options || Array.isArray(options)) throw invalid("must be an object such as { site, sitemap: true, robots: true }.")
  const { site, sitemap, robots, markdown, rss, mcp, llms, dateLeases } = options as Record<string, unknown>
  if (site !== undefined) siteOrigin(site, invalid)
  if (llms !== undefined && llms !== true && llms !== false) {
    if (llms === null || Object(llms) !== llms || Array.isArray(llms)) throw invalid("llms must be true, false, or { title, description, details, sections }.")
    for (const key of ["title", "description", "details"]) {
      const value: unknown = Reflect.get(llms, key)
      if (value !== undefined && String(value) !== value) throw invalid(`llms.${key} must be text.`)
    }
    const sections: unknown = Reflect.get(llms, "sections")
    if (sections !== undefined && (!Array.isArray(sections) || !sections.every(isLlmsSection))) {
      throw invalid("llms.sections must be a list of { title, description?, links: [{ title, href, description? }] }.")
    }
  }
  if (sitemap !== undefined && sitemap !== true && sitemap !== false) throw invalid("sitemap must be true or false.")
  if (markdown !== undefined && markdown !== true && markdown !== false) {
    const shape = "markdown must be true, false, or { prefix: '/raw' }."
    if (markdown === null || Object(markdown) !== markdown || Array.isArray(markdown)) throw invalid(shape)
    const prefix: unknown = Reflect.get(markdown, "prefix")
    if (prefix !== undefined && (String(prefix) !== prefix || !/^\/[^/?#\s]+(?:\/[^/?#\s]+)*$/.test(prefix))) throw invalid(`${shape} The prefix starts with / and does not end with one.`)
  }
  if (dateLeases !== undefined && (dateLeases === null || typeof dateLeases !== "object" || typeof Reflect.get(dateLeases, "acquire") !== "function" || typeof Reflect.get(dateLeases, "get") !== "function")) {
    throw invalid("dateLeases must be an atomic LeaseStore with acquire() and get().")
  }
  if (rss !== undefined && rss !== true && rss !== false) {
    const shape = "rss must be true, false, or { title, description, limit }."
    if (rss === null || Object(rss) !== rss || Array.isArray(rss)) throw invalid(shape)
    const { title, description, limit } = rss as Record<string, unknown>
    if ((title !== undefined && String(title) !== title) || (description !== undefined && String(description) !== description)) throw invalid(shape)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500)) throw invalid("rss limit must be an integer from 1 to 500.")
  }
  if (mcp !== undefined && mcp !== true && mcp !== false) {
    const shape = "mcp must be true, false, or { name }."
    if (mcp === null || Object(mcp) !== mcp || Array.isArray(mcp)) throw invalid(shape)
    const { name } = mcp as Record<string, unknown>
    if (name !== undefined && (String(name) !== name || !name.trim())) throw invalid(shape)
  }
  if (robots !== undefined && robots !== true && robots !== false) {
    if (robots === null || Object(robots) !== robots || Array.isArray(robots)) throw invalid("robots must be true, false, or { disallow: ['/path'] }.")
    const disallow = Reflect.get(robots, "disallow")
    if (disallow !== undefined && (!Array.isArray(disallow) || disallow.some(path => String(path) !== path || !path.startsWith("/")))) {
      throw invalid("robots must be true, false, or { disallow: ['/path'] }.")
    }
  }
  const normalized = options as DefineContentSeoOptions
  if (llms === undefined || llms === false) return normalized
  // The llms files link to the `.md` copies of each page.
  if (markdown === false) throw invalid("llms links to the .md copy of each page. Remove markdown: false, or set llms: false.")
  return { ...normalized, markdown: normalized.markdown ?? true }
}

function isText(value: unknown): value is string {
  return String(value) === value
}

function isLlmsSection(value: unknown): boolean {
  if (value === null || Object(value) !== value) return false
  const { title, description, links } = value as Record<string, unknown>
  return isText(title) && (description === undefined || isText(description)) && Array.isArray(links) && links.every((link: unknown) => {
    if (link === null || Object(link) !== link) return false
    const fields = link as Record<string, unknown>
    return isText(fields.title) && isText(fields.href) && (fields.description === undefined || isText(fields.description))
  })
}

/** The origin of a site URL, such as `https://example.com`, with the path of a mounted app and no trailing slash. */
export function siteOrigin(site: unknown, invalid: (message: string) => Error = message => contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] ${message}` })): string {
  if (String(site) !== site || !/^https?:\/\//i.test(site)) throw invalid(`site must be an absolute http(s) URL such as https://example.com, received ${JSON.stringify(site)}.`)
  try {
    // A site mounted below a path keeps it, such as `https://example.com/docs`, so every URL carries it.
    const url = new URL(site)
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  }
  catch {
    throw invalid(`site must be an absolute http(s) URL such as https://example.com, received ${JSON.stringify(site)}.`)
  }
}

function absolute(path: string, site: string | undefined): string {
  if (/^https?:\/\//i.test(path)) return path
  return site ? `${site}${path.startsWith("/") ? "" : "/"}${path}` : path
}

/** A read-only Source whose documents have a URL, from `contentSource(input, { url })`. */
export interface ContentSitemapSource {
  name: string
  url: ContentDocumentUrl
  /** The SEO values of a document, from `contentSource(input, { seo })`. Defaults to `data.seo`. */
  seo?: (document: { id: string, key?: string, data: Record<string, unknown> }) => ContentSourceSeo | undefined
  list(): Promise<ReadonlyArray<{ path: string, data: Record<string, unknown>, meta?: { key?: string, extension?: string } }>>
}

/** A published page with a URL, as the sitemap and the RSS feed list it. */
export interface ContentRoutedPage extends ContentSitemapEntry {
  /** The page is a Markdown document. */
  markdown: boolean
  title?: string
  description?: string
  /** The Source key of a Source page, for `content.history()`. */
  key?: string
  /** The `date` field of the page, as an ISO timestamp. */
  date?: string
}

function dateField(data: Record<string, unknown>): string | undefined {
  const value: unknown = data.date
  const time = value instanceof Date ? value.getTime() : String(value) === value ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

/**
 * The published pages of every routable collection: published documents with a URL, without `noindex` and without a
 * canonical URL that points elsewhere. A collection with locales lists each published translation, but not the pages
 * that show the source locale as a fallback. Singletons with a `url` are included. Then the documents of every Source
 * with a `url`. `all` keeps `noindex` pages and pages whose canonical URL points elsewhere: they have a Markdown copy too.
 */
export async function contentRoutedPages(collections: readonly AnyContentCollection[], site: string | undefined, sources: readonly ContentSitemapSource[] = [], options: { all?: boolean } = {}): Promise<ContentRoutedPage[]> {
  const pages: ContentRoutedPage[] = []
  const seen = new Set<string>()
  for (const collection of collections) {
    if (!collection.routable) continue
    for (const locale of collection.locales ?? [undefined]) {
      let cursor: string | undefined
      do {
        const page = await collection.list({ ref: "published", limit: 1_000, ...(cursor ? { cursor } : {}), ...(locale === undefined ? {} : { locale }) })
        for (const document of page.items) {
          // A locale without a translation shows the source locale page, whose own URL is the one to index.
          if (document.fallback || String(document.url) !== document.url) continue
          const seo: unknown = collection.seo ? document.data[collection.seo] : undefined
          const noindex = seo !== null && Object(seo) === seo && Reflect.get(Object(seo), "noindex") === true
          if (noindex && !options.all) continue
          const loc = absolute(document.url, site)
          const canonical: unknown = seo !== null && Object(seo) === seo ? Reflect.get(Object(seo), "canonical") : undefined
          if (String(canonical) === canonical && absolute(canonical, site) !== loc && !options.all) continue
          if (seen.has(loc)) continue
          seen.add(loc)
          const entry: ContentRoutedPage = { collection: collection.name, id: document.id, loc, markdown: collection.format === "markdown" }
          if (document.locale !== undefined) entry.locale = document.locale
          if (document.updatedAt) entry.lastmod = document.updatedAt
          const title = stringField(seo, "title") ?? stringField(document.data, collection.titleField) ?? stringField(document.data, "title")
          const description = stringField(seo, "description") ?? stringField(document.data, "description")
          if (title) entry.title = title
          if (description) entry.description = description
          pages.push(entry)
        }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
    }
  }
  for (const source of sources) {
    for (const document of await source.list()) {
      const id = document.path.replace(/^\/+/, "")
      // Comark keys a file as `<source>/<Source key>`.
      const fileKey = document.meta?.key
      const key = fileKey?.startsWith(`${source.name}/`) ? fileKey.slice(source.name.length + 1) : fileKey
      const url = contentDocumentUrl(source.url, { id, data: document.data, ...key === undefined ? {} : { key } })
      if (url === null) continue
      const loc = absolute(url, site)
      const seo: unknown = source.seo ? source.seo({ id, data: document.data, ...key === undefined ? {} : { key } }) : document.data.seo
      if (seo !== null && Object(seo) === seo && Reflect.get(Object(seo), "noindex") === true && !options.all) continue
      const canonical: unknown = seo !== null && Object(seo) === seo ? Reflect.get(Object(seo), "canonical") : undefined
      if (String(canonical) === canonical && absolute(canonical, site) !== loc && !options.all) continue
      if (seen.has(loc)) continue
      seen.add(loc)
      const entry: ContentRoutedPage = { collection: source.name, id, loc, markdown: document.meta?.extension === undefined || /^\.?(?:md|markdown)$/i.test(document.meta.extension) }
      if (key) entry.key = key
      const title = stringField(seo, "title") ?? stringField(document.data, "title")
      const description = stringField(seo, "description") ?? stringField(document.data, "description")
      const date = dateField(document.data)
      if (title) entry.title = title
      if (description) entry.description = description
      if (date) entry.date = date
      pages.push(entry)
    }
  }
  return pages
}

/** The sitemap entries of the routed pages. A Source page gets `lastmod` from `dates`, its latest history entry. */
export function contentSitemapEntries(pages: readonly ContentRoutedPage[], dates: ReadonlyMap<ContentRoutedPage, string>): ContentSitemapEntry[] {
  if (pages.length > contentSitemapLimit) {
    throw contentErrorDiagnostics.CONTENT_R0009({ message: `[vitehub] The Content sitemap has ${pages.length} URLs, exceeding the ${contentSitemapLimit}-URL sitemap limit. Split the routes across sitemap files.` })
  }
  return pages.map((page) => {
    const entry: ContentSitemapEntry = { collection: page.collection, id: page.id, loc: page.loc }
    if (page.locale !== undefined) entry.locale = page.locale
    const lastmod = page.lastmod ?? dates.get(page)
    if (lastmod) entry.lastmod = lastmod
    return entry
  })
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!)
}

/** Render sitemap entries as a sitemaps.org `urlset` document. */
export function renderContentSitemap(entries: readonly ContentSitemapEntry[]): string {
  const urls = entries.map(entry => `  <url>\n    <loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ""}\n  </url>`)
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}${urls.length ? "\n" : ""}</urlset>\n`
}

/** robots.txt that allows every crawler, keeps `disallow` paths out, and names the sitemap when there is one. */
export function renderContentRobots(options: { site?: string, sitemap?: boolean, disallow?: readonly string[] }): string {
  const lines = ["User-agent: *", ...(options.disallow?.length ? options.disallow.map(path => `Disallow: ${path}`) : ["Allow: /"])]
  if (options.sitemap) lines.push("", `Sitemap: ${absolute("/sitemap.xml", options.site)}`)
  return `${lines.join("\n")}\n`
}

/**
 * The page that a Markdown copy stands for: `/blog/hello.md` is `/blog/hello`, and `/index.md` is `/`. With the
 * `seo.markdown` prefix, such as `/raw`, `/raw/blog/hello.md` is `/blog/hello` too.
 */
export function contentMarkdownCopyPage(path: string, prefix = ""): string | undefined {
  let pathname = path.split(/[?#]/, 1)[0]!
  if (!pathname.endsWith(".md")) return
  if (prefix && pathname.startsWith(`${prefix}/`)) pathname = pathname.slice(prefix.length)
  return pathname === "/index.md" ? "/" : pathname.slice(0, -3)
}

/** The folder of the Markdown copies from `seo: { markdown: { prefix } }`, such as `/raw`, or an empty string. */
export function markdownPrefix(seo: Pick<DefineContentSeoOptions, "markdown"> | undefined): string {
  const markdown = seo?.markdown
  return markdown !== null && typeof markdown === "object" ? markdown.prefix ?? "" : ""
}

/** The label of a Source without `contentSource(input, { label })`: its name in title case, such as `Docs`. */
export function contentLabel(name: string): string {
  return titleCase(name)
}

function stringField(data: unknown, field: string | undefined): string | undefined {
  if (!field || data === null || Object(data) !== data) return
  const value: unknown = Reflect.get(Object(data), field)
  return String(value) === value && value.trim() ? value : undefined
}

/** Root-relative links and images, such as `](/guide)`, become absolute outside fenced code. */
async function absoluteLinks(markdown: string, site: string | undefined): Promise<string> {
  if (!site) return markdown
  // Use the parser's source ranges so fences inside lists and blockquotes obey the same rules as the page.
  const codeLines = new Set<number>()
  await parseMarkdown<ComarkPlugin[]>(markdown, {
    autoClose: false,
    registerDefaultPlugins: false,
    plugins: [{
      name: "markdown-copy-code",
      markdownItPost({ tokens }) {
        for (const token of tokens) {
          if ((token.type === "fence" || token.type === "code_block") && token.map) {
            for (let line = token.map[0]; line < token.map[1]; line++) codeLines.add(line)
          }
        }
      },
    }],
  })
  return markdown.split("\n").map((line, index) => {
    if (codeLines.has(index)) return line
    return line
      .replace(/\]\(\/(?!\/)/g, `](${site}/`)
      .replace(/^( {0,3}\[(?:\\.|[^\]\\])+\]:[ \t]*<?)\/(?!\/)/, `$1${site}/`)
  }).join("\n")
}

const trimRoute = (route: string) => route.replace(/\/+$/, "") || "/"

/** Find a public Markdown URL when `resolve()` misses a singleton or selects an ineligible collection. */
async function routedMarkdown(collections: Iterable<AnyContentCollection>, page: string): Promise<{ collection: string, id: string, locale?: string } | null> {
  for (const collection of collections) {
    if (!collection.routable || collection.format !== "markdown") continue
    let cursor: string | undefined
    do {
      const result = await collection.list({ ref: "published", limit: 1_000, ...(cursor ? { cursor } : {}) })
      for (const document of result.items) {
        if (String(document.url) === document.url && trimRoute(document.url) === trimRoute(page)) return { collection: collection.name, id: document.id }
      }
      cursor = result.nextCursor ?? undefined
    } while (cursor)
  }
  return null
}

/**
 * The Markdown copy of the published document that a path plus `.md` names, or null. It starts with the document's
 * title, unless the body has its own, and its description as a quote.
 */
export async function contentMarkdownCopy(runtime: Pick<ContentCollectionsRuntime, "collection" | "collections" | "resolve">, path: string, site: string | undefined): Promise<string | null> {
  const page = contentMarkdownCopyPage(path)
  if (page === undefined) return null
  let resolved = await runtime.resolve(page, { ref: "published" })
  const matchedCollection = resolved ? runtime.collection(resolved.collection) : undefined
  if (!matchedCollection?.routable || matchedCollection.format !== "markdown") resolved = await routedMarkdown(runtime.collections.values(), page)
  if (!resolved) return null
  const collection = runtime.collection(resolved.collection)
  if (!collection.routable || collection.format !== "markdown") return null
  const document = await collection.get(resolved.id, { ref: "published", ...(resolved.locale === undefined ? {} : { locale: resolved.locale }) })
  if (!document) return null
  const seo: unknown = collection.seo ? document.data[collection.seo] : undefined
  const title = stringField(seo, "title") ?? stringField(document.data, collection.titleField)
  const description = stringField(seo, "description") ?? stringField(document.data, "description")
  return await renderMarkdownCopy({ title, description, body: document.body }, site)
}

/**
 * A Markdown copy of a page: its title as a heading, unless the body has its own, its description as a quote, then the
 * body with root-relative links made absolute when `site` is known.
 */
export async function renderMarkdownCopy(page: { title?: string, description?: string, body: string }, site: string | undefined): Promise<string> {
  const body = page.body.trim()
  const head = [
    page.title && !/^#\s/.test(body) ? `# ${page.title}` : undefined,
    page.description ? `> ${page.description.replace(/\s*\n\s*/g, " ")}` : undefined,
  ].filter(Boolean)
  return `${[...head, await absoluteLinks(body, site)].filter(Boolean).join("\n\n")}\n`
}
