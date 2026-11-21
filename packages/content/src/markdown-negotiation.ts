// Markdown negotiation and the Markdown 404 body. This module imports no Markdown parser, so the generated middleware
// can load it when the server starts and load server/content.ts only on the first request that asks for Markdown.
import { contentReadDenied, contentReadGated } from "./read-gate.ts"

import type { ContentHandlerOptions, ContentReadAccess } from "./read-gate.ts"
import type { DefineContentSeoOptions } from "./sitemap.ts"

/** The `Vary` value of every response that depends on the `Accept` header. */
export const contentMarkdownVary = "Accept"

/**
 * The parts of the `User-Agent` header of fetchers that read a page for an AI chat or an AI search index. They get the
 * Markdown copy, as if they sent `Accept: text/markdown`. `seo: { markdown: { userAgents } }` replaces the list.
 */
const aiUserAgents: readonly string[] = ["ChatGPT-User", "OAI-SearchBot", "GPTBot", "Claude-User", "Claude-SearchBot", "ClaudeBot", "Perplexity-User", "PerplexityBot"]

/** The `.md` copy of a page URL: `/blog/hello.md` for `/blog/hello`, and `/index.md` for `/`, below `prefix` if any. */
export function markdownCopyUrl(url: string, prefix = ""): string {
  const path = url.replace(/\/+$/, "")
  return `${prefix}${path ? `${path}.md` : "/index.md"}`
}

interface AcceptEntry {
  type: string
  /** The media type parameters before `q`, such as `charset`. Keys and charset values are lowercase. */
  params: Record<string, string>
  q: number
}

function parseAccept(accept: string | null): AcceptEntry[] {
  if (!accept) return []
  const entries: AcceptEntry[] = []
  for (const part of accept.split(",")) {
    const [range, ...rest] = part.trim().split(";")
    const type = range?.trim().toLowerCase()
    if (!type) continue
    let q = 1
    const params: Record<string, string> = {}
    for (const param of rest) {
      const [rawKey, ...value] = param.split("=")
      const key = rawKey?.trim().toLowerCase()
      const text = value.join("=").trim().replace(/^"(.*)"$/, "$1")
      if (!key) continue
      if (key === "q") {
        const parsed = Number.parseFloat(text)
        if (!Number.isNaN(parsed)) q = Math.min(Math.max(parsed, 0), 1)
        // Parameters after `q` are Accept extensions, not media type parameters.
        break
      }
      params[key] = key === "charset" ? text.toLowerCase() : text
    }
    entries.push({ type, params, q })
  }
  return entries
}

/** The parameters of the HTML page and of the Markdown copy that the server sends. */
const served: Readonly<Record<string, string>> = { charset: "utf-8" }

/**
 * The range that decides `target`: the most specific one that matches it (the type with parameters, the type itself,
 * then `type/*`, then `*\/*`), with its quality, how specific its type is, and its place in the header. A range with a
 * parameter that the served copy does not have, such as `charset=iso-8859-1`, does not match.
 */
function matchingRange(entries: readonly AcceptEntry[], target: string): { q: number, specificity: number, index: number } {
  const type = target.split("/")[0]
  let best = { q: 0, rank: 0, specificity: 0, index: Infinity }
  for (const [index, entry] of entries.entries()) {
    const keys = Object.keys(entry.params)
    if (keys.some(key => served[key] !== entry.params[key])) continue
    const specificity = entry.type === target ? 3 : entry.type === `${type}/*` ? 2 : entry.type === "*/*" ? 1 : 0
    if (!specificity) continue
    const rank = specificity * 2 + (keys.length ? 1 : 0)
    if (rank > best.rank || (rank === best.rank && entry.q > best.q)) best = { q: entry.q, rank, specificity, index }
  }
  return { q: best.q, specificity: best.specificity, index: best.index }
}

/**
 * Whether an `Accept` header asks for Markdown before HTML: `text/markdown` with a higher quality than `text/html`. At
 * the same quality, a type named exactly beats a range such as `text/*`, and else the type listed first wins. Without
 * `text/markdown` in the header, a range such as `text/*` gives Markdown only when HTML is refused. Both are sent as
 * UTF-8, so a range with another `charset` refuses them.
 */
export function acceptsMarkdown(accept: string | null): boolean {
  const entries = parseAccept(accept)
  const html = matchingRange(entries, "text/html")
  const markdown = matchingRange(entries, "text/markdown")
  if (!entries.some(entry => entry.type === "text/markdown")) return html.q === 0 && markdown.q > 0
  if (markdown.q !== html.q) return markdown.q > html.q
  return markdown.q > 0 && (markdown.specificity !== html.specificity ? markdown.specificity > html.specificity : markdown.index < html.index)
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
   * Send a request through the app inside the server, such as `serverFetch` from `nitro`. A Markdown request at a page
   * URL gets the answer of the app route at the page URL plus `.md`. With `seo: { markdown: { pages: true } }`, a page
   * that has no such route and is not a Content document gets its HTML converted.
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

function isMarkdown(headers: Headers): boolean {
  return /^\s*text\/markdown\b/i.test(headers.get("content-type") ?? "")
}

function markdownUserAgents(seo: DefineContentSeoOptions | undefined): readonly string[] {
  const markdown = seo?.markdown
  if (!markdown) return []
  return typeof markdown === "object" ? markdown.userAgents ?? aiUserAgents : aiUserAgents
}

/**
 * The header that marks the requests the middleware sends through the app, such as the page that it converts. They pass
 * through it. Its value is random per server, so a reader cannot skip the middleware with it. Workers allow random values
 * only inside a request, so it is made on the first one.
 */
const renderHeader = "x-vitehub-markdown-render"
let renderToken: string | undefined

/** Whether `X-Robots-Tag` keeps a page out of indexes. A copy of such a page would undo it. */
function noindex(headers: Headers | undefined): boolean {
  return /\b(?:noindex|none)\b/i.test(headers?.get("x-robots-tag") ?? "")
}

function joinRobots(...values: (string | null | undefined)[]): string | undefined {
  const joined = [...new Set(values.map(value => value?.trim()).filter(Boolean))].join(", ")
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
 * Serve Markdown copies as H3 middleware, not as a Fetchable route. Nitro routes can match `/**.md` now, but `<url>.md`
 * and `Accept: text/markdown` at a page URL share this one middleware, so it stays.
 *
 * - `<url>.md` returns the copy from `content.markdown()`.
 * - A page URL with `Accept: text/markdown` before `text/html`, or from an AI fetcher by `User-Agent`, returns the same
 *   copy. Without a Content copy, it returns the answer of an app route at the page URL plus `.md` with
 *   `Content-Type: text/markdown`.
 * - A Markdown request that no handler answers gets a Markdown 404 body.
 * - Negotiable URLs vary on `Accept` and, when enabled, `User-Agent`. A successful HTML page with a known copy
 *   gets a `Link` header naming it. The public `/robots.txt` route does not negotiate.
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
    const token = renderToken ??= crypto.randomUUID()
    if (request.headers.get(renderHeader) === token) return
    const url = new URL(request.url)
    if (url.pathname === "/robots.txt") return
    const copy = url.pathname.endsWith(".md")
    // A dot can belong to a document ID or configured URL. Only Content can decide whether a copy exists.
    const page = !copy
    const twin = markdownCopyUrl(url.pathname)
    let loaded: ContentMarkdownRuntime | undefined
    const load = async () => loaded ??= typeof content === "function" ? await content() : content
    const userAgent = request.headers.get("user-agent")?.toLowerCase()
    // An AI fetcher gets the copy whatever it accepts. Its answer varies on User-Agent too.
    const accepted = page && acceptsMarkdown(request.headers.get("accept"))
    const byAgent = page && !accepted && !!userAgent && markdownUserAgents((await load()).seo).some(name => userAgent.includes(name.toLowerCase()))
    const negotiated = accepted || byAgent
    const setHeader = (name: string, value: string) => {
      event.res?.headers.set(name, value)
      event.res?.errHeaders?.set(name, value)
    }
    // H3 overwrites returned Response headers with prepared headers. Merge after downstream handlers finish.
    const mergeNegotiatedVary = (seo: DefineContentSeoOptions | undefined, value?: string | null) => mergeVary(
      event.res?.headers.get("vary"), event.res?.errHeaders?.get("vary"), value,
      markdownUserAgents(seo).length ? "User-Agent" : undefined,
    )
    const vary = (result: unknown, seo: DefineContentSeoOptions | undefined) => setHeader("vary", mergeNegotiatedVary(seo, resultHeaders(result)?.get("vary")))
    const alternate = async (result: unknown) => {
      if (!page || !event.res) return result
      const status = responseStatus(result) ?? event.res.status ?? 200
      const runtime = await load()
      const seo = runtime.seo
      if (!seo?.markdown) return result
      const missing = result === notFound || status === 404
      const varies = render !== undefined || contentReadGated(runtime) || missing
      if (varies) vary(result, seo)
      if (missing || (varies && status !== 200)) return result
      const headers = resultHeaders(result)?.has("content-type") ? resultHeaders(result) : event.res.headers
      const html = status === 200 && isHtml(headers)
      // With `pages`, every HTML page that indexes may list has a converted copy.
      const converted = html && render !== undefined && convertsPages(seo) && !noindex(resultHeaders(result)) && !noindex(event.res.headers)
      const exists = converted || (runtime.hasMarkdown ? await runtime.hasMarkdown(twin) : await runtime.markdown(twin) !== null)
      if (!exists) return result
      if (!varies) vary(result, seo)
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
        await alternate(error)
        throw error
      }
    }
    if (!copy && !negotiated) return await alternate(await downstream())
    const runtime = await load()
    const seo = runtime.seo
    if (!seo?.markdown) return
    const denied = await contentReadDenied(runtime, request, options)
    if (denied) {
      if (negotiated) vary(denied, seo)
      setHeader("cache-control", "private, no-store")
      return denied
    }
    const gated = contentReadGated(runtime)
    if (gated) setHeader("cache-control", "private, no-store")
    const site = seo.site ?? url.origin
    const target = copy ? copyPage(url.pathname, seo) : url.pathname
    const respond = async (body: string, status = 200, page?: Headers, robots?: string | null) => {
      const headers = new Headers({
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": gated ? "private, no-store" : status === 200 ? "public, max-age=0, must-revalidate" : "no-cache",
      })
      if (page) {
        // A page rendered with the reader's credentials is theirs: a shared cache must not give it to another reader.
        const cookies = page.getSetCookie()
        for (const cookie of cookies) headers.append("set-cookie", cookie)
        const cache = page.get("cache-control")
        if (!gated && cache && privateCache(cache)) headers.set("cache-control", cache)
        else if (cookies.length || request.headers.has("cookie") || request.headers.has("authorization")) headers.set("cache-control", "private, no-store")
        // The copy keeps the indexing rules of its page, and names the page as the canonical URL.
        const indexing = joinRobots(event.res?.headers.get("x-robots-tag"), robots)
        if (indexing) {
          headers.set("x-robots-tag", indexing)
          setHeader("x-robots-tag", indexing)
        }
        headers.set("link", `<${url.origin}${target}>; rel="canonical"`)
      }
      // A converted copy varies on what its page varies on, such as Cookie, except Accept: the render asks for HTML.
      const pageVary = page?.get("vary")?.split(",").filter(field => field.trim().toLowerCase() !== "accept").join(",")
      const varyValue = negotiated ? mergeNegotiatedVary(seo, pageVary) : joinVary([pageVary])
      if (varyValue) headers.set("vary", varyValue)
      const cache = headers.get("cache-control")
      const preparedCache = event.res?.headers.get("cache-control") ?? null
      if (cache && privateCache(cache)) {
        const policy = privateCache(preparedCache) && preparedCache !== cache ? "private, no-store" : cache
        headers.set("cache-control", policy)
        setHeader("cache-control", policy)
      }
      let response: Response
      if (status !== 200) response = new Response(request.method === "HEAD" ? null : body, { status, headers })
      else {
        headers.set("content-location", `${copy ? url.pathname : twin}${url.search}`)
        const etag = await markdownEtag(body)
        headers.set("etag", etag)
        const fresh = etagMatches(request.headers.get("if-none-match"), etag)
        if (fresh) headers.delete("content-type")
        response = new Response(fresh || request.method === "HEAD" ? null : body, { status: fresh ? 304 : status, headers })
      }
      if (negotiated) setHeader("vary", varyValue)
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
    /** Send a request through the app for the same reader. It passes through this middleware. */
    const fetchApp = async (path: string, accept: string) => {
      const headers = new Headers(request.headers)
      headers.set("accept", accept)
      headers.set(renderHeader, token)
      for (const name of conditionalHeaders) headers.delete(name)
      return await render!(new Request(new URL(`${path}${url.search}`, url), { headers, signal: request.signal }))
    }
    // Exact copies win. Next, a route of the app at the page URL plus `.md` gives the copy of a page whose HTML does not
    // hold its text, such as a page that draws it in the browser. The `.md` URL reaches that route without this step.
    if (negotiated && render) {
      const routed = await fetchApp(twin, "text/markdown")
      if (routed.status === 200 && isMarkdown(routed.headers)) return await respond(await routed.text(), 200, routed.headers, routed.headers.get("x-robots-tag"))
      await routed.body?.cancel()
    }
    // Without one, `pages` converts the HTML page that the app renders for the same reader.
    const converts = render !== undefined && convertsPages(seo) && !target.endsWith(".md")
    /** The converted copy, or the answer of the page. Null when the page has neither: a `.md` URL then gets the 404. */
    const convert = async (): Promise<Response | null> => {
      const page = await fetchApp(target, "text/html")
      if (page.status === 200 && isHtml(page.headers) && !noindex(page.headers)) {
        const html = await page.text()
        const { renderPageMarkdown, robotsMeta } = await import("./markdown-pages.ts")
        const robots = joinRobots(page.headers.get("x-robots-tag"), robotsMeta(html))
        return await respond(renderPageMarkdown(html, { origin: new URL(`${target}${url.search}`, site).href }), 200, page.headers, robots)
      }
      // A redirect, such as to a sign-in page, or an error is the answer for the copy too. A page that is not HTML, or
      // that `X-Robots-Tag` keeps out of indexes, has no copy, and its own URL keeps its answer.
      if (page.status !== 404 && (negotiated || page.status !== 200)) {
        if (negotiated) vary(page, seo)
        return page
      }
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
      if (negotiated) vary(error, seo)
      throw error
    }
    const status = responseStatus(result) ?? event.res?.status ?? 200
    if (result === notFound || status === 404) return await fallback()
    // A single-page app answers every path with its HTML shell. A `.md` URL that only the shell matches has no copy.
    const type = resultHeaders(result)?.get("content-type") ?? event.res?.headers.get("content-type") ?? ""
    if (copy && status === 200 && /^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(type)) return await fallback()
    if (negotiated && (render || gated)) vary(result, seo)
    return result
  }
}
