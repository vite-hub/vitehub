// Markdown negotiation and the Markdown 404 body. This module imports no Markdown parser, so the generated middleware
// can load it when the server starts and load server/content.ts only on the first request that asks for Markdown.
import type { DefineContentSeoOptions } from "./sitemap.ts"

/** The `Vary` value of every response that depends on the `Accept` header. */
export const contentMarkdownVary = "Accept"

/** The `.md` copy of a page URL: `/blog/hello.md` for `/blog/hello`, and `/index.md` for `/`. */
export function markdownCopyUrl(url: string): string {
  const path = url.replace(/\/+$/, "")
  return path ? `${path}.md` : "/index.md"
}

interface AcceptEntry {
  type: string
  q: number
}

function parseAccept(accept: string | null): AcceptEntry[] {
  if (!accept) return []
  const entries: AcceptEntry[] = []
  for (const part of accept.split(",")) {
    const [range, ...params] = part.trim().split(";")
    const type = range?.trim().toLowerCase()
    if (!type) continue
    let q = 1
    for (const param of params) {
      const [key, value] = param.split("=")
      if (key?.trim().toLowerCase() !== "q") continue
      const parsed = Number.parseFloat(value?.trim() ?? "")
      if (!Number.isNaN(parsed)) q = Math.min(Math.max(parsed, 0), 1)
    }
    entries.push({ type, q })
  }
  return entries
}

/** The quality of the most specific range that matches `target`: the type itself, then `type/*`, then `*\/*`. */
function acceptQuality(entries: readonly AcceptEntry[], target: string): number {
  const type = target.split("/")[0]
  let specificity = 0
  let q = 0
  for (const entry of entries) {
    const rank = entry.type === target ? 3 : entry.type === `${type}/*` ? 2 : entry.type === "*/*" ? 1 : 0
    if (!rank) continue
    if (rank > specificity) {
      specificity = rank
      q = entry.q
    }
    else if (rank === specificity) q = Math.max(q, entry.q)
  }
  return q
}

/**
 * Whether an `Accept` header asks for Markdown before HTML: `text/markdown` with a quality at least that of
 * `text/html`, or a range such as `text/*` that matches Markdown but not HTML.
 */
export function acceptsMarkdown(accept: string | null): boolean {
  const entries = parseAccept(accept)
  const html = acceptQuality(entries, "text/html")
  const markdown = Math.max(0, ...entries.filter(entry => entry.type === "text/markdown").map(entry => entry.q))
  if (markdown) return markdown >= html
  return html === 0 && acceptQuality(entries, "text/markdown") > 0
}

/** A link in the "Where to look next" list of the Markdown 404 body. */
export interface ContentMarkdownErrorLink {
  title: string
  href: string
}

/** The links that the Markdown 404 body lists for the files that `seo` serves. */
export function contentMarkdownErrorLinks(seo: { sitemap?: boolean, llms?: unknown }): ContentMarkdownErrorLink[] {
  const llms = seo.llms !== undefined && seo.llms !== false
  return [
    ...llms ? [{ title: "Sitemap (Markdown): every page on the site", href: "/sitemap.md" }] : [],
    ...llms ? [{ title: "llms.txt: index of the documentation for LLMs", href: "/llms.txt" }] : [],
    ...llms ? [{ title: "llms-full.txt: the full documentation as a single file", href: "/llms-full.txt" }] : [],
    ...seo.sitemap === true ? [{ title: "Sitemap (XML)", href: "/sitemap.xml" }] : [],
  ]
}

/** The Markdown body of a 404 for a request that asked for Markdown, with YAML frontmatter and links to look next. */
export function renderContentMarkdownNotFound(options: { path: string, site: string, links: readonly ContentMarkdownErrorLink[] }): string {
  const site = options.site.replace(/\/$/, "")
  const pathname = options.path.split(/[?#]/, 1)[0]!.replace(/(.)\/+$/, "$1").replace(/[`\\\r\n]+/g, "").slice(0, 200)
  const links = options.links.map(link => `- [${link.title}](${link.href.startsWith("/") && !link.href.startsWith("//") ? `${site}${link.href}` : link.href})`)
  return [
    "---",
    `title: ${JSON.stringify("Page Not Found")}`,
    "status: 404",
    "---",
    "",
    "# 404 Page Not Found",
    "",
    `The page \`${pathname}\` does not exist on ${site}.`,
    "",
    ...links.length ? ["## Where to look next", "", ...links, ""] : [],
    "## Fetching markdown",
    "",
    "Any documentation page is available as markdown: append `.md` to its URL",
    "or send `Accept: text/markdown`.",
    "",
  ].join("\n")
}

/**
 * H3 middleware: it returns nothing to pass the request on to the next handler. With `next`, it may also read or replace
 * the response of the handlers after it.
 */
export type ContentMiddleware = (event: { req: Request, res?: { status?: number, headers: Headers, errHeaders?: Headers } }, next?: () => unknown) => Promise<unknown>

/** The part of a Content runtime that Markdown copies need. */
export interface ContentMarkdownRuntime {
  readonly seo: DefineContentSeoOptions | undefined
  markdown(path: string, options?: { site?: string }): Promise<string | null>
}

const notFound = Symbol.for("h3.notFound")

/**
 * Fetch Responses (including srvx's Response class) and H3's branded HTTPResponse. Keep plain JSON status fields
 * separate from response metadata, and use H3's shared brand without loading its server runtime here.
 */
function isResponse(value: unknown): value is { status?: unknown } {
  return value !== null && typeof value === "object"
    && (Reflect.get(value, Symbol.for("h3.HTTPResponse")) === true || ("ok" in value && "status" in value && "headers" in value))
}

function responseStatus(value: unknown): number | undefined {
  if (isResponse(value)) return typeof value.status === "number" ? value.status : undefined
  if (value instanceof Error) {
    const status = errorStatus(value)
    return typeof status === "number" ? status : 500
  }
}

function errorStatus(error: unknown): unknown {
  if (error === null || typeof error !== "object") return
  return Reflect.get(error, "status") ?? Reflect.get(error, "statusCode")
}

function markdownVary(...values: (string | null | undefined)[]): string {
  const fields = new Map<string, string>()
  for (const value of [...values, contentMarkdownVary]) {
    for (const field of value?.split(",") ?? []) {
      const name = field.trim()
      if (name === "*") return "*"
      if (name) fields.set(name.toLowerCase(), name)
    }
  }
  return [...fields.values()].join(", ")
}

/**
 * Serve Markdown copies as H3 middleware, not as a Fetchable route: Nitro routes cannot match a suffix.
 *
 * - `<url>.md` returns the copy from `content.markdown()`.
 * - A page URL with `Accept: text/markdown` before `text/html` returns the same copy. Page responses get `Vary: Accept`.
 * - A Markdown request that no handler answers gets a Markdown 404 body.
 *
 * Every other request passes through. Pass the Content runtime, or a function that loads it: the middleware then loads
 * Content only for requests that ask for Markdown. ViteHub generates it when `defineContent({ seo: { markdown: true } })`.
 */
export function defineContentMarkdownHandler(content: ContentMarkdownRuntime | (() => ContentMarkdownRuntime | Promise<ContentMarkdownRuntime>)): ContentMiddleware {
  return async (event, next) => {
    if (typeof content !== "function" && content.seo?.markdown !== true) return
    const request = event.req
    if (request.method !== "GET" && request.method !== "HEAD") return
    const url = new URL(request.url)
    const copy = url.pathname.endsWith(".md")
    // A dot can belong to a document ID or configured URL. Only Content can decide whether a copy exists.
    const page = !copy
    const negotiated = page && acceptsMarkdown(request.headers.get("accept"))
    const vary = (result: unknown) => {
      if (page && event.res) {
        const headers: unknown = isResponse(result) || result instanceof Error ? Reflect.get(result, "headers") : undefined
        const value = markdownVary(event.res.headers.get("vary"), event.res.errHeaders?.get("vary"), headers instanceof Headers ? headers.get("vary") : undefined)
        // H3 overwrites returned Response headers with prepared headers. Merge after downstream handlers finish.
        event.res.headers.set("vary", value)
        event.res.errHeaders?.set("vary", value)
      }
      return result
    }
    const downstream = async () => {
      try {
        return vary(await next?.())
      }
      catch (error) {
        vary(error)
        throw error
      }
    }
    if (!copy && !negotiated) return await downstream()
    const runtime = typeof content === "function" ? await content() : content
    const seo = runtime.seo
    if (seo?.markdown !== true) return
    const site = seo.site ?? url.origin
    const respond = (body: string, status = 200) => new Response(request.method === "HEAD" ? null : body, {
      status,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": status === 200 ? "public, max-age=0, must-revalidate" : "no-cache",
        ...negotiated ? { vary: contentMarkdownVary } : {},
      },
    })
    const markdown = await runtime.markdown(copy ? url.pathname : markdownCopyUrl(url.pathname), { site })
    if (markdown !== null) return vary(respond(markdown))
    if (!next) return
    const missing = () => vary(respond(renderContentMarkdownNotFound({ path: url.pathname, site, links: contentMarkdownErrorLinks(seo) }), 404))
    let result: unknown
    try {
      result = await downstream()
    }
    catch (error) {
      if (errorStatus(error) === 404) return missing()
      throw error
    }
    if (result === notFound || (responseStatus(result) ?? event.res?.status) === 404) return missing()
    return result
  }
}
