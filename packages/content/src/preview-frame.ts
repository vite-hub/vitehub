import { getDomain } from "tldts"

import { contentPreviewErrorName, contentPreviewFrameParameter } from "./preview-parameters.ts"

/** How many redirects a preview frame follows in the server before it shows an error. */
const maximumFrameRedirects = 5

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

/**
 * The page a preview frame gets when it cannot show the document. It is private, and `<meta name>` of
 * `contentPreviewErrorName` holds the message, so the Console shows it with a way to retry. Cookies that redirects set
 * before it still go to the browser.
 */
export function frameError(status: number, message: string, setCookies: readonly string[] = []): Response {
  const text = escapeHtml(message)
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" })
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="${contentPreviewErrorName}" content="${text}"><title>Preview unavailable</title></head><body><p>${text}</p></body></html>`, { status, headers })
}

interface FrameResponse {
  status: number
  statusText: string
  headers: Headers
  body: ReadableStream<Uint8Array> | null
  text(): Promise<string>
}

function isFrameResponse(value: unknown): value is FrameResponse {
  if (value === null || Object(value) !== value) return false
  const headers: unknown = Reflect.get(Object(value), "headers")
  return typeof Reflect.get(Object(value), "status") === "number" && headers instanceof Object && Reflect.get(headers, "get") instanceof Function
}

/** Each `Set-Cookie` of a response. Undefined on a host whose `Headers` only joins them, which cannot split them safely. */
function setCookiesOf(headers: Headers): string[] | undefined {
  if (headers.getSetCookie instanceof Function) return headers.getSetCookie()
  return headers.get("set-cookie") === null ? [] : undefined
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

/**
 * The origins a frame may follow a redirect to: its own, and the one of the host a proxy forwards. Every one of them
 * runs in this server, so following a redirect never makes a request to another host.
 */
export function frameOrigins(url: URL, forwardedHost: string | undefined): string[] {
  const origins = [url.origin]
  const host = forwardedHost?.split(",", 1)[0]?.trim()
  if (host && URL.canParse(`${url.protocol}//${host}`)) origins.push(new URL(`${url.protocol}//${host}`).origin)
  return origins
}

/**
 * Runs a preview frame page and follows its redirects in the frame scope, such as a locale or canonical redirect. The
 * browser would follow them without the form, so without the token and the document on screen. A redirect may set
 * cookies: the next page gets them in its `Cookie` header, as the browser would send them, and the browser gets every
 * `Set-Cookie` in order with the last page. A redirect to another origin, past the limit, or to an address that is not
 * valid gets the error page, because the frame cannot show the document there. `render` runs one GET of the page.
 */
export async function followFrameRedirects(
  start: { url: URL, cookie: string | undefined, origins: readonly string[] },
  render: (url: URL, cookie: string | undefined) => Promise<unknown>,
): Promise<unknown> {
  let url = start.url
  let cookie = start.cookie
  const jar: JarCookie[] = []
  let hash: string | undefined
  const setCookies: string[] = []
  for (let hop = 0; ; hop++) {
    const result = await render(url, cookie)
    const location = isFrameResponse(result) && isRedirect(result.status) ? result.headers.get("location") : null
    if (!isFrameResponse(result) || location === null) return hop ? await landed(result, setCookies, url, hash, start.url) : result
    const cookies = setCookiesOf(result.headers)
    result.body?.cancel().catch(() => undefined)
    if (!cookies) return frameError(502, "The page redirects and sets cookies that this server cannot read one by one, so the preview cannot follow it. Open the page in a new tab.", setCookies)
    setCookies.push(...cookies.map(cookie => withCookiePath(cookie, url, start.url)))
    const target = URL.canParse(location, url.href) ? new URL(location, url) : undefined
    if (!target) return frameError(502, "The page redirects to an address that is not valid, so the preview cannot show it.", setCookies)
    if (!start.origins.includes(target.origin)) {
      return frameError(502, `The page redirects to ${target.origin}, which is another site. The preview shows pages of this site only.`, setCookies)
    }
    if (hop === maximumFrameRedirects) {
      return frameError(502, `The page redirects more than ${maximumFrameRedirects} times, so the preview stopped.`, setCookies)
    }
    keepCookies(jar, cookies, url)
    // Request cookies have no Domain metadata: never assume they also belong to a forwarded host.
    cookie = cookieHeaderFor(target.hostname === start.url.hostname ? start.cookie : undefined, jar, target)
    // A server never sees the fragment. The browser takes the one of the redirect, else it keeps the one it has.
    if (target.hash) hash = target.hash
    target.hash = ""
    target.searchParams.delete(contentPreviewFrameParameter)
    url = target
  }
}

/**
 * The last page of a followed redirect, with the cookies of the redirects before its own. An HTML page also gets the
 * address it has in the browser: the frame shows it at the URL it posted to, and a client router would otherwise read
 * the route of that URL instead of the one the server rendered.
 */
async function landed(result: unknown, setCookies: readonly string[], url: URL, hash: string | undefined, posted: URL): Promise<unknown> {
  if (!isFrameResponse(result)) return result
  const headers = new Headers()
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  for (const cookie of setCookiesOf(result.headers) ?? []) headers.append("set-cookie", withCookiePath(cookie, url, posted))
  for (const [name, value] of result.headers) {
    if (name.toLowerCase() !== "set-cookie" || !(result.headers.getSetCookie instanceof Function)) headers.append(name, value)
  }
  let body: ReadableStream<Uint8Array> | string | null = result.body
  if (body && /^text\/html\b/i.test(headers.get("content-type") ?? "") && !headers.has("content-encoding")) {
    body = withAddress(await result.text(), url, hash)
    headers.delete("content-length")
  }
  return new Response(body, { status: result.status, statusText: result.statusText, headers })
}

function withAddress(html: string, url: URL, hash: string | undefined): string {
  const address = new URL(url)
  address.searchParams.set(contentPreviewFrameParameter, "")
  const literal = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c")
  const script = `<script>history.replaceState(history.state,"",${literal(`${address.pathname}${address.search}`)}+${hash ? literal(hash) : "location.hash"})</script>`
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head) return `${html.slice(0, head.index + head[0].length)}${script}${html.slice(head.index + head[0].length)}`
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  return doctype ? `${doctype[0]}${script}${html.slice(doctype[0].length)}` : `${script}${html}`
}

function localHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]"
}

/** The path a browser gives a cookie without `Path`: the directory of the URL that set it. */
function defaultCookiePath(url: URL): string {
  return url.pathname.slice(0, Math.max(1, url.pathname.lastIndexOf("/")))
}

/**
 * A `Set-Cookie` of a page the server reached by a redirect, for the browser. The browser sets it from the URL the frame
 * posted to, so a cookie without `Path` gets the default path of the page that set it.
 */
function withCookiePath(cookie: string, from: URL, posted: URL): string {
  const [pair = "", ...parts] = cookie.split(";")
  const path = parts.find(part => part.trim().toLowerCase().startsWith("path="))?.split("=", 2)[1]?.trim()
  // A __Host- cookie needs its own Path=/; adding one would make the browser keep a cookie that it refuses.
  if (/^\s*__host-/i.test(pair)) return cookie
  if (path?.startsWith("/") || defaultCookiePath(from) === defaultCookiePath(posted)) return cookie
  const kept = path === undefined ? parts : parts.filter(part => !part.trim().toLowerCase().startsWith("path="))
  return [pair, ...kept, ` Path=${defaultCookiePath(from)}`].join(";")
}

function pathMatches(path: string, cookiePath: string): boolean {
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"))
}

/** A cookie that a followed redirect set, with its browser scope. */
interface JarCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  path: string
  secure: boolean
  expired: boolean
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * Keeps the cookies that a redirect sets in `jar`, when the browser would keep them: not for another domain or a
 * public suffix, and not `Secure` from plain HTTP other than localhost. Name, domain and path identify a cookie.
 */
function keepCookies(jar: JarCookie[], setCookies: readonly string[], from: URL): void {
  for (const line of setCookies) {
    const [pair = "", ...parts] = line.split(";")
    const separator = pair.indexOf("=")
    const name = separator < 0 ? "" : pair.slice(0, separator).trim()
    if (!name) continue
    const attributes = new Map(parts.map((part) => {
      const equals = part.indexOf("=")
      return [(equals < 0 ? part : part.slice(0, equals)).trim().toLowerCase(), equals < 0 ? "" : part.slice(equals + 1).trim()] as const
    }))
    const domain = attributes.get("domain")?.replace(/^\./, "").toLowerCase()
    // Include private suffixes (such as github.io), which browsers also isolate between tenants.
    if (domain && (!domainMatches(from.hostname, domain) || !getDomain(domain, { allowPrivateDomains: true }))) continue
    if (attributes.has("secure") && from.protocol !== "https:" && !localHost(from.hostname)) continue
    // Cookie prefixes: __Secure- needs Secure, and __Host- also needs Path=/ and no Domain.
    if (/^__secure-/i.test(name) && !attributes.has("secure")) continue
    if (/^__host-/i.test(name) && (!attributes.has("secure") || attributes.get("path") !== "/" || attributes.has("domain"))) continue
    const attributePath = attributes.get("path")
    const path = attributePath?.startsWith("/") ? attributePath : defaultCookiePath(from)
    const maxAge = attributes.get("max-age")
    const expires = attributes.get("expires")
    const expired = maxAge !== undefined && /^-?\d+$/.test(maxAge) ? Number(maxAge) <= 0 : expires !== undefined && Date.parse(expires) <= Date.now()
    const cookie = { name, value: pair.slice(separator + 1).trim(), domain: domain || from.hostname, hostOnly: !domain, path, secure: attributes.has("secure"), expired }
    const index = jar.findIndex(entry => entry.name === name && entry.domain === cookie.domain && entry.path === path)
    if (index < 0) jar.push(cookie)
    else jar[index] = cookie
  }
}

/**
 * The `Cookie` header of a page in a redirect chain: the cookies of the frame request, and the ones that redirects set
 * whose scope matches the page, as the browser would send them. A cookie that a redirect set or expired for the page
 * takes the place of the request cookies of the same name.
 */
function cookieHeaderFor(header: string | undefined, jar: readonly JarCookie[], to: URL): string | undefined {
  const matching = jar.filter(cookie => pathMatches(to.pathname, cookie.path)
    && (cookie.hostOnly ? to.hostname === cookie.domain : domainMatches(to.hostname, cookie.domain))
    && (!cookie.secure || to.protocol === "https:" || localHost(to.hostname)))
  const names = new Set(matching.map(cookie => cookie.name))
  const pairs = (header ?? "").split(";").map(pair => pair.trim()).filter(pair => pair && !names.has(pair.slice(0, Math.max(0, pair.indexOf("="))).trim()))
  // Longer paths first, as browsers order them.
  for (const cookie of [...matching].sort((left, right) => right.path.length - left.path.length)) {
    if (!cookie.expired) pairs.push(`${cookie.name}=${cookie.value}`)
  }
  return pairs.length ? pairs.join("; ") : undefined
}
