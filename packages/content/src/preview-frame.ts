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
  let hash: string | undefined
  const setCookies: string[] = []
  for (let hop = 0; ; hop++) {
    const result = await render(url, cookie)
    const location = isFrameResponse(result) && isRedirect(result.status) ? result.headers.get("location") : null
    if (!isFrameResponse(result) || location === null) return hop ? await landed(result, setCookies, url, hash) : result
    const cookies = setCookiesOf(result.headers)
    result.body?.cancel().catch(() => undefined)
    if (!cookies) return frameError(502, "The page redirects and sets cookies that this server cannot read one by one, so the preview cannot follow it. Open the page in a new tab.", setCookies)
    setCookies.push(...cookies)
    const target = URL.canParse(location, url.href) ? new URL(location, url) : undefined
    if (!target) return frameError(502, "The page redirects to an address that is not valid, so the preview cannot show it.", setCookies)
    if (!start.origins.includes(target.origin)) {
      return frameError(502, `The page redirects to ${target.origin}, which is another site. The preview shows pages of this site only.`, setCookies)
    }
    if (hop === maximumFrameRedirects) {
      return frameError(502, `The page redirects more than ${maximumFrameRedirects} times, so the preview stopped.`, setCookies)
    }
    cookie = nextCookieHeader(cookie, cookies, url, target)
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
async function landed(result: unknown, setCookies: readonly string[], url: URL, hash: string | undefined): Promise<unknown> {
  if (!isFrameResponse(result)) return result
  const headers = new Headers()
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  for (const [name, value] of result.headers) headers.append(name, value)
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

function pathMatches(path: string, cookiePath: string): boolean {
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith("/") || path[cookiePath.length] === "/"))
}

/**
 * The `Cookie` header of the next page in a redirect chain: the cookies of this request, with the ones that a redirect
 * sets, changes, or expires, when the browser would keep them and send them to that page. A cookie that a redirect sets
 * takes the place of any cookie of the same name.
 */
export function nextCookieHeader(header: string | undefined, setCookies: readonly string[], from: URL, to: URL): string | undefined {
  let pairs = (header ?? "").split(";").map(pair => pair.trim()).filter(Boolean)
  for (const line of setCookies) {
    const [pair = "", ...parts] = line.split(";")
    const separator = pair.indexOf("=")
    const name = separator < 0 ? "" : pair.slice(0, separator).trim()
    if (!name) continue
    const attributes = new Map(parts.map((part) => {
      const equals = part.indexOf("=")
      return [(equals < 0 ? part : part.slice(0, equals)).trim().toLowerCase(), equals < 0 ? "" : part.slice(equals + 1).trim()] as const
    }))
    // The browser drops a cookie for another domain, and a Secure cookie from plain HTTP other than localhost.
    const domain = attributes.get("domain")?.replace(/^\./, "").toLowerCase()
    if (domain && from.hostname !== domain && !from.hostname.endsWith(`.${domain}`)) continue
    if (attributes.has("secure") && from.protocol !== "https:" && !localHost(from.hostname)) continue
    const attributePath = attributes.get("path")
    const path = attributePath?.startsWith("/") ? attributePath : from.pathname.slice(0, Math.max(1, from.pathname.lastIndexOf("/")))
    if (!pathMatches(to.pathname, path)) continue
    const maxAge = attributes.get("max-age")
    const expires = attributes.get("expires")
    const expired = maxAge !== undefined && /^-?\d+$/.test(maxAge) ? Number(maxAge) <= 0 : expires !== undefined && Date.parse(expires) <= Date.now()
    pairs = pairs.filter(entry => entry.slice(0, Math.max(0, entry.indexOf("="))).trim() !== name)
    if (!expired) pairs.push(`${name}=${pair.slice(separator + 1).trim()}`)
  }
  return pairs.length ? pairs.join("; ") : undefined
}
