// Markdown negotiation and the Markdown 404 body. This module imports no Markdown parser, so the generated middleware
// can load it when the server starts and load server/content.ts only on the first request that asks for Markdown.
import { contentReadDenied, contentReadGated } from "./read-gate.ts"

import type { ContentHandlerOptions, ContentReadAccess } from "./read-gate.ts"
import type { DefineContentSeoOptions } from "./sitemap.ts"

/** The `Vary` value of every response that depends on the `Accept` header. */
export const contentMarkdownVary = "Accept"

/** The `.md` copy of a page URL: `/blog/hello.md` for `/blog/hello`, and `/index.md` for `/`, below `prefix` if any. */
export function markdownCopyUrl(url: string, prefix = ""): string {
  const path = url.replace(/\/+$/, "")
  return `${prefix}${path ? `${path}.md` : "/index.md"}`
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
export interface ContentMarkdownRuntime extends ContentReadAccess {
  readonly seo: DefineContentSeoOptions | undefined
  markdown(path: string, options?: { site?: string }): Promise<string | null>
  /** Whether `markdown(path)` has a copy. Without it, the middleware renders the copy to find out. */
  hasMarkdown?(path: string): Promise<boolean>
}

/** `defineContentMarkdownHandler(content, options)`. */
export interface ContentMarkdownHandlerOptions extends ContentHandlerOptions {
  /**
   * Render a page as HTML inside the server, such as `serverFetch` from `nitro`. With `seo: { markdown: { pages: true } }`,
   * a Markdown request for a page that is not a Content document gets the page converted from this HTML.
   */
  render?: (request: Request) => Response | Promise<Response>
}

const notFound = Symbol.for("h3.notFound")

/** Whether `seo.markdown` converts app pages that are not Content documents. */
function convertsPages(seo: DefineContentSeoOptions | undefined): boolean {
  const markdown = seo?.markdown
  return markdown !== null && typeof markdown === "object" && markdown.pages === true
}

/** The page that a copy URL names: `/blog/hello` for `/blog/hello.md` and `/raw/blog/hello.md`, `/` for `/index.md`. */
function copyPage(path: string, seo: DefineContentSeoOptions | undefined): string {
  const markdown = seo?.markdown
  const prefix = markdown !== null && typeof markdown === "object" ? markdown.prefix ?? "" : ""
  const page = prefix && path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path
  return page === "/index.md" ? "/" : page.slice(0, -3)
}

function isHtml(headers: Headers | undefined): boolean {
  return /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(headers?.get("content-type") ?? "")
}

/** Whether `X-Robots-Tag` keeps a page out of indexes. A copy of such a page would undo it. */
function noindex(headers: Headers | undefined): boolean {
  return /\b(?:noindex|none)\b/i.test(headers?.get("x-robots-tag") ?? "")
}

function joinRobots(...values: (string | null | undefined)[]): string | undefined {
  const joined = values.map(value => value?.trim()).filter(Boolean).join(", ")
  return joined || undefined
}

/** Whether a `Cache-Control` value keeps a response private to one reader. */
function privateCache(value: string | null): boolean {
  return value !== null && /(?:^|,)\s*(?:private|no-store)\b/i.test(value)
}

/** Request headers that ask for part of a response or a cached one. The page render asks for the whole page. */
const conditionalHeaders = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range", "range"]

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

/** Join `Vary` values without repeats. `*` wins over every field. */
function joinVary(values: readonly (string | null | undefined)[]): string {
  const fields = new Map<string, string>()
  for (const value of values) {
    for (const field of value?.split(",") ?? []) {
      const name = field.trim()
      if (name === "*") return "*"
      if (name) fields.set(name.toLowerCase(), name)
    }
  }
  return [...fields.values()].join(", ")
}

function mergeVary(...values: (string | null | undefined)[]): string {
  return joinVary([...values, contentMarkdownVary])
}

/** The `Link` header value that names the Markdown copy of a page. */
export function markdownAlternateLink(href: string): string {
  return `<${href}>; rel="alternate"; type="text/markdown"`
}

function resultHeaders(result: unknown): Headers | undefined {
  const headers: unknown = isResponse(result) || result instanceof Error ? Reflect.get(result, "headers") : undefined
  return headers instanceof Headers ? headers : undefined
}

/** A strong ETag from the SHA-256 digest of the body. */
async function markdownEtag(body: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))
  let hex = ""
  for (const byte of digest.subarray(0, 16)) hex += byte.toString(16).padStart(2, "0")
  return `"${hex}"`
}

/** Whether an `If-None-Match` header names `etag`. The weak comparison of RFC 9110 ignores `W/`. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false
  return header.split(",").some((tag) => {
    const value = tag.trim()
    return value === "*" || value.replace(/^W\//, "") === etag
  })
}

/**
 * Serve Markdown copies as H3 middleware, not as a Fetchable route: Nitro routes cannot match a suffix.
 *
 * - `<url>.md` returns the copy from `content.markdown()`.
 * - A page URL with `Accept: text/markdown` before `text/html` returns the same copy.
 * - A Markdown request that no handler answers gets a Markdown 404 body.
 * - Every response at a page URL with a copy gets `Vary: Accept`; a successful HTML page also gets a
 *   `Link` header naming the copy. Page 404s vary too, because Markdown requests get the Markdown 404.
 *
 * A copy has `Content-Location` and an `ETag`, so `If-None-Match` gets a 304. A Markdown request first asks
 * `authorize` with `action: "read"`, as `/api/content/**` does. Every other request passes through. Pass the Content
 * runtime, or a function that loads it: the middleware loads Content for Markdown requests and to check whether
 * downstream responses have copies. ViteHub generates it when `defineContent({ seo: { markdown: true } })`.
 */
export function defineContentMarkdownHandler(content: ContentMarkdownRuntime | (() => ContentMarkdownRuntime | Promise<ContentMarkdownRuntime>), options: ContentMarkdownHandlerOptions = {}): ContentMiddleware {
  const render = options.render
  return async (event, next) => {
    if (typeof content !== "function" && !content.seo?.markdown) return
    const request = event.req
    if (request.method !== "GET" && request.method !== "HEAD") return
    const url = new URL(request.url)
    const copy = url.pathname.endsWith(".md")
    // A dot can belong to a document ID or configured URL. Only Content can decide whether a copy exists.
    const page = !copy
    const negotiated = page && acceptsMarkdown(request.headers.get("accept"))
    const twin = markdownCopyUrl(url.pathname)
    const load = async () => typeof content === "function" ? await content() : content
    const setHeader = (name: string, value: string) => {
      event.res?.headers.set(name, value)
      event.res?.errHeaders?.set(name, value)
    }
    // H3 overwrites returned Response headers with prepared headers. Merge after downstream handlers finish.
    const vary = (result: unknown) => setHeader("vary", mergeVary(event.res?.headers.get("vary"), event.res?.errHeaders?.get("vary"), resultHeaders(result)?.get("vary")))
    /** Vary copy-backed responses and page 404s; advertise copies only from successful HTML pages. */
    const alternate = async (result: unknown) => {
      if (!page || !event.res) return result
      const status = responseStatus(result) ?? event.res.status ?? 200
      if (result === notFound || status === 404) {
        vary(result)
        return result
      }
      const headers = resultHeaders(result)?.has("content-type") ? resultHeaders(result) : event.res.headers
      const html = status === 200 && isHtml(headers)
      const runtime = await load()
      if (!runtime.seo?.markdown) return result
      // With `pages`, every HTML page that indexes may list has a converted copy.
      const converted = html && render !== undefined && convertsPages(runtime.seo) && !noindex(resultHeaders(result)) && !noindex(event.res.headers)
      const exists = converted || (runtime.hasMarkdown ? await runtime.hasMarkdown(twin) : await runtime.markdown(twin) !== null)
      if (!exists) return result
      vary(result)
      if (!html) return result
      const links = [event.res.headers.get("link"), resultHeaders(result)?.get("link"), markdownAlternateLink(twin)].filter(Boolean)
      event.res.headers.set("link", [...new Set(links)].join(", "))
      return result
    }
    const downstream = async () => {
      try {
        return await next?.()
      }
      catch (error) {
        if (page && errorStatus(error) === 404) vary(error)
        throw error
      }
    }
    if (!copy && !negotiated) return await alternate(await downstream())
    const runtime = await load()
    const seo = runtime.seo
    if (!seo?.markdown) return
    const denied = await contentReadDenied(runtime, request, options)
    if (denied) {
      vary(denied)
      setHeader("cache-control", "private, no-store")
      return denied
    }
    if (contentReadGated(runtime)) setHeader("cache-control", "private, no-store")
    const site = seo.site ?? url.origin
    const target = copy ? copyPage(url.pathname, seo) : url.pathname
    const respond = async (body: string, status = 200, page?: Headers, robots?: string) => {
      const gated = contentReadGated(runtime)
      const headers = new Headers({
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": gated ? "private, no-store" : status === 200 ? "public, max-age=0, must-revalidate" : "no-cache",
      })
      if (page) {
        // A page rendered with the reader's credentials is theirs: a shared cache must not give it to another reader.
        const cookies = page.getSetCookie()
        for (const cookie of cookies) headers.append("set-cookie", cookie)
        if (!gated && privateCache(page.get("cache-control"))) headers.set("cache-control", page.get("cache-control")!)
        else if (cookies.length || request.headers.has("cookie") || request.headers.has("authorization")) headers.set("cache-control", "private, no-store")
        // The copy keeps the indexing rules of its page, and names the page as the canonical URL.
        if (robots) headers.set("x-robots-tag", robots)
        headers.set("link", `<${url.origin}${target}>; rel="canonical"`)
      }
      // A converted copy varies on what its page varies on, such as Cookie, except Accept: the render asks for HTML.
      const pageVary = page?.get("vary")?.split(",").filter(field => field.trim().toLowerCase() !== "accept").join(",")
      const varyValue = negotiated ? mergeVary(pageVary) : joinVary([pageVary])
      if (varyValue) headers.set("vary", varyValue)
      let response: Response
      if (status !== 200) response = new Response(request.method === "HEAD" ? null : body, { status, headers })
      else {
        headers.set("content-location", copy ? url.pathname : twin)
        const etag = await markdownEtag(body)
        headers.set("etag", etag)
        const fresh = etagMatches(request.headers.get("if-none-match"), etag)
        if (fresh) headers.delete("content-type")
        response = new Response(fresh || request.method === "HEAD" ? null : body, { status: fresh ? 304 : status, headers })
      }
      if (negotiated) vary(response)
      // H3 sets the prepared headers on a returned Response, so a prepared `Link`, such as from route rules, keeps the
      // canonical link next to it.
      const link = response.headers.get("link")
      const prepared = event.res?.headers.get("link")
      if (link && prepared && prepared !== link) event.res!.headers.set("link", `${prepared}, ${link}`)
      return response
    }
    const markdown = await runtime.markdown(copy ? url.pathname : twin, { site })
    if (markdown !== null) return await respond(markdown)
    const missing = async () => await respond(renderContentMarkdownNotFound({ path: url.pathname, site, links: contentMarkdownErrorLinks(seo) }), 404)
    // Exact copies win. Without one, `pages` converts the HTML page that the app renders for the same reader.
    const converts = render !== undefined && convertsPages(seo) && !target.endsWith(".md")
    /** The converted copy, or the answer of the page. Null when the page has neither: a `.md` URL then gets the 404. */
    const convert = async (): Promise<Response | null> => {
      const headers = new Headers(request.headers)
      headers.set("accept", "text/html")
      for (const name of conditionalHeaders) headers.delete(name)
      const page = await render!(new Request(new URL(`${target}${url.search}`, url), { headers, signal: request.signal }))
      if (page.status === 200 && isHtml(page.headers) && !noindex(page.headers)) {
        const html = await page.text()
        const { renderPageMarkdown, robotsMeta } = await import("./markdown-pages.ts")
        const robots = joinRobots(page.headers.get("x-robots-tag"), robotsMeta(html))
        return await respond(renderPageMarkdown(html, { origin: new URL(`${target}${url.search}`, site).href }), 200, page.headers, robots)
      }
      // A redirect, such as to a sign-in page, or an error is the answer for the copy too. A page that is not HTML, or
      // that `X-Robots-Tag` keeps out of indexes, has no copy, and its own URL keeps its answer.
      if (page.status !== 404 && (negotiated || page.status !== 200)) return page
      await page.body?.cancel()
      return page.status === 404 ? await missing() : null
    }
    // A page URL renders the page once. A `.md` URL goes on to the app first, so a route such as `/sitemap.md` answers.
    if (converts && negotiated) return await convert()
    if (!next) return
    const prepared = new Headers(event.res?.headers)
    const preparedErrors = new Headers(event.res?.errHeaders)
    const fallback = async () => {
      // Discard metadata written by the failed route, retaining earlier middleware headers.
      for (const [headers, saved] of [[event.res?.headers, prepared], [event.res?.errHeaders, preparedErrors]] as const) {
        if (!headers) continue
        for (const name of [...headers.keys()]) headers.delete(name)
        for (const [name, value] of saved) headers.set(name, value)
      }
      return (converts ? await convert() : null) ?? await missing()
    }
    let result: unknown
    try {
      result = await next()
    }
    catch (error) {
      if (errorStatus(error) === 404) return await fallback()
      throw error
    }
    if (result === notFound || (responseStatus(result) ?? event.res?.status) === 404) return await fallback()
    return result
  }
}
