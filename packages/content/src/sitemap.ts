import { contentErrorDiagnostics } from "./error-diagnostics.ts"

import type { AnyContentCollection } from "./collections-types.ts"
import type { ContentCollectionsRuntime } from "./collections-runtime.ts"

/** `defineContent({ seo })`: site-wide SEO routes generated from routable collections. */
export interface DefineContentSeoOptions {
  /** Public origin, such as `https://example.com`. Defaults to the origin of each sitemap or robots.txt request. */
  site?: string
  /** Serve `/sitemap.xml` with the published documents of every collection that has a `url`. */
  sitemap?: boolean
  /** Serve `/robots.txt` that allows crawling and names the sitemap. `disallow` adds paths to keep out. */
  robots?: boolean | { disallow?: readonly string[] }
  /**
   * Serve each published Markdown document with a URL as Markdown at that URL plus `.md`, such as `/blog/hello.md`
   * for `/blog/hello` and `/index.md` for `/`, so agents can read it and readers can paste it into a chat.
   */
  markdown?: boolean
}

export interface ContentSitemapEntry {
  collection: string
  id: string
  /** Absolute URL when a site is known, otherwise the document path. */
  loc: string
  /** When the published document last changed, as an ISO timestamp. */
  lastmod?: string
}

export interface ContentSitemapOptions {
  /** Public origin. Defaults to `defineContent({ seo: { site } })`. */
  site?: string
}

/** One sitemap file holds at most this many URLs. */
export const contentSitemapLimit = 50_000

export function normalizeSeoOptions(options: unknown): DefineContentSeoOptions | undefined {
  if (options === undefined) return
  const invalid = (message: string) => contentErrorDiagnostics.CONTENT_R0006({ message: `[vitehub] defineContent({ seo }) ${message}` })
  if (options === null || Object(options) !== options || Array.isArray(options)) throw invalid("must be an object such as { site, sitemap: true, robots: true }.")
  const { site, sitemap, robots, markdown } = options as Record<string, unknown>
  if (site !== undefined) siteOrigin(site, invalid)
  if (sitemap !== undefined && sitemap !== true && sitemap !== false) throw invalid("sitemap must be true or false.")
  if (markdown !== undefined && markdown !== true && markdown !== false) throw invalid("markdown must be true or false.")
  if (robots !== undefined && robots !== true && robots !== false) {
    if (robots === null || Object(robots) !== robots || Array.isArray(robots)) throw invalid("robots must be true, false, or { disallow: ['/path'] }.")
    const disallow = Reflect.get(robots, "disallow")
    if (disallow !== undefined && (!Array.isArray(disallow) || disallow.some(path => String(path) !== path || !path.startsWith("/")))) {
      throw invalid("robots must be true, false, or { disallow: ['/path'] }.")
    }
  }
  return options as DefineContentSeoOptions
}

/** The origin of a site URL, such as `https://example.com`, without a trailing slash. */
export function siteOrigin(site: unknown, invalid: (message: string) => Error = message => contentErrorDiagnostics.CONTENT_R0008({ message: `[vitehub] ${message}` })): string {
  if (String(site) !== site || !/^https?:\/\//i.test(site)) throw invalid(`site must be an absolute http(s) URL such as https://example.com, received ${JSON.stringify(site)}.`)
  try {
    return new URL(site).origin
  }
  catch {
    throw invalid(`site must be an absolute http(s) URL such as https://example.com, received ${JSON.stringify(site)}.`)
  }
}

function absolute(path: string, site: string | undefined): string {
  if (/^https?:\/\//i.test(path)) return path
  return site ? `${site}${path.startsWith("/") ? "" : "/"}${path}` : path
}

/**
 * The sitemap entries of every routable collection: published documents with a URL, without `noindex` and without a
 * canonical URL that points elsewhere. Singletons with a `url` are included.
 */
export async function contentSitemapEntries(collections: readonly AnyContentCollection[], site: string | undefined): Promise<ContentSitemapEntry[]> {
  const entries: ContentSitemapEntry[] = []
  const seen = new Set<string>()
  for (const collection of collections) {
    if (!collection.routable) continue
    let cursor: string | undefined
    do {
      const page = await collection.list({ ref: "published", limit: 1_000, ...(cursor ? { cursor } : {}) })
      for (const document of page.items) {
        if (String(document.url) !== document.url) continue
        const seo: unknown = collection.seo ? document.data[collection.seo] : undefined
        const noindex = seo !== null && Object(seo) === seo && Reflect.get(Object(seo), "noindex") === true
        if (noindex) continue
        const loc = absolute(document.url, site)
        const canonical: unknown = seo !== null && Object(seo) === seo ? Reflect.get(Object(seo), "canonical") : undefined
        if (String(canonical) === canonical && absolute(canonical, site) !== loc) continue
        if (seen.has(loc)) continue
        seen.add(loc)
        const entry: ContentSitemapEntry = { collection: collection.name, id: document.id, loc }
        if (document.updatedAt) entry.lastmod = document.updatedAt
        entries.push(entry)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)
  }
  if (entries.length > contentSitemapLimit) {
    throw contentErrorDiagnostics.CONTENT_R0009({ message: `[vitehub] The Content sitemap has ${entries.length} URLs, exceeding the ${contentSitemapLimit}-URL sitemap limit. Split the routes across sitemap files.` })
  }
  return entries
}

function escapeXml(value: string): string {
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

/** The page that a Markdown copy stands for: `/blog/hello.md` is `/blog/hello`, and `/index.md` is `/`. */
function markdownCopyPage(path: string): string | undefined {
  const pathname = path.split(/[?#]/, 1)[0]!
  if (!pathname.endsWith(".md")) return
  return pathname.slice(0, -3).replace(/(^|\/)index$/, "/")
}

function stringField(data: unknown, field: string | undefined): string | undefined {
  if (!field || data === null || Object(data) !== data) return
  const value: unknown = Reflect.get(Object(data), field)
  return String(value) === value && value.trim() ? value : undefined
}

/** Root-relative links and images, such as `](/guide)`, become absolute outside fenced code. */
function absoluteLinks(markdown: string, site: string | undefined): string {
  if (!site) return markdown
  let fence: string | undefined
  return markdown.split("\n").map((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker
      return line
    }
    return fence ? line : line.replace(/\]\(\/(?!\/)/g, `](${site}/`)
  }).join("\n")
}

const trimRoute = (route: string) => route.replace(/\/+$/, "") || "/"

/** `resolve()` maps only `documents()` collections, while the sitemap also lists singletons with a `url`. */
async function routedSingleton(collections: Iterable<AnyContentCollection>, page: string): Promise<{ collection: string, id: string } | null> {
  for (const collection of collections) {
    if (collection.kind !== "singleton" || !collection.routable) continue
    const [document] = (await collection.list({ ref: "published", limit: 1 })).items
    if (document && String(document.url) === document.url && trimRoute(document.url) === trimRoute(page)) return { collection: collection.name, id: document.id }
  }
  return null
}

/**
 * The Markdown copy of the published document that a path plus `.md` names, or null. It starts with the document's
 * title, unless the body has its own, and its description as a quote.
 */
export async function contentMarkdownCopy(runtime: Pick<ContentCollectionsRuntime, "collection" | "collections" | "resolve">, path: string, site: string | undefined): Promise<string | null> {
  const page = markdownCopyPage(path)
  if (page === undefined) return null
  const resolved = await runtime.resolve(page, { ref: "published" }) ?? await routedSingleton(runtime.collections.values(), page)
  if (!resolved) return null
  const collection = runtime.collection(resolved.collection)
  if (collection.format !== "markdown") return null
  const document = await collection.get(resolved.id, { ref: "published" })
  if (!document) return null
  const seo: unknown = collection.seo ? document.data[collection.seo] : undefined
  const title = stringField(seo, "title") ?? stringField(document.data, collection.titleField)
  const description = stringField(seo, "description") ?? stringField(document.data, "description")
  const body = document.body.trim()
  const head = [
    title && !/^#\s/.test(body) ? `# ${title}` : undefined,
    description ? `> ${description.replace(/\s*\n\s*/g, " ")}` : undefined,
  ].filter(Boolean)
  return `${[...head, absoluteLinks(body, site)].filter(Boolean).join("\n\n")}\n`
}
