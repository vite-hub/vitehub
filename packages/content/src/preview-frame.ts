import { contentPreviewErrorName, contentPreviewFrameParameter } from "./preview-parameters.ts"

/** How many redirects the browser follows with a preview frame form before the frame shows an error. */
const maximumFrameRedirects = 5

/** The statuses that a browser follows as a redirect. */
const redirectStatuses = new Set([301, 302, 303, 307, 308])

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`)
}

/**
 * The page a preview frame gets when it cannot show the document. It is private, and `<meta name>` of
 * `contentPreviewErrorName` holds the message, so the Console shows it with a way to retry. `setCookies` are the
 * `Set-Cookie` values of the page response that it replaces, which the browser sets for this URL as usual.
 */
export function frameError(status: number, message: string, setCookies: readonly string[] = []): Response {
  const text = escapeHtml(message)
  const headers = new Headers({ "cache-control": "private, no-store", "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex, nofollow" })
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="${contentPreviewErrorName}" content="${text}"><title>Preview unavailable</title></head><body><p>${text}</p></body></html>`, { status, headers })
}

interface FrameResponse {
  status: number
  headers: Headers
  body: ReadableStream<Uint8Array> | null
}

function isFrameResponse(value: unknown): value is FrameResponse {
  if (value === null || Object(value) !== value) return false
  const headers: unknown = Reflect.get(Object(value), "headers")
  return typeof Reflect.get(Object(value), "status") === "number" && headers instanceof Object && Reflect.get(headers, "get") instanceof Function
}

/** Each `Set-Cookie` of a response. A host whose `Headers` only joins them gives the joined value, as it would send it. */
function setCookiesOf(headers: Headers): string[] {
  if (headers.getSetCookie instanceof Function) return headers.getSetCookie()
  const joined = headers.get("set-cookie")
  return joined === null ? [] : [joined]
}

/** The redirects a frame request came through: the value of its frame parameter. The first request has none. */
export function frameHop(url: URL): number {
  const value = url.searchParams.get(contentPreviewFrameParameter) ?? ""
  return /^\d{1,2}$/.test(value) ? Number(value) : 0
}

/** The query parts of `search` without the frame parameter. The other parts keep their exact encoding. */
function otherParameters(search: string): string[] {
  return search.slice(1).split("&").filter((part) => {
    if (!part) return false
    const name = part.split("=", 1)[0]!.replaceAll("+", " ")
    try {
      return decodeURIComponent(name) !== contentPreviewFrameParameter
    }
    catch {
      return true
    }
  })
}

/** The page URL of a frame request: its URL without the frame parameter, with the rest of the query as it is. */
export function framePageUrl(url: URL): URL {
  const page = new URL(url)
  const parts = otherParameters(page.search)
  page.search = parts.length ? `?${parts.join("&")}` : ""
  return page
}

/**
 * The answer of a preview frame page. A redirect to the same origin as the frame, the same scheme, host, and port,
 * becomes a `307` to the same `Location` with the frame parameter set to the next hop. The browser then posts the same
 * form there and selects the cookies for that URL itself, and it sets each `Set-Cookie` of the redirect as it does for
 * any response. The next request runs the page again with the form, as a GET. A redirect to another origin, past
 * `maximumFrameRedirects`, or to an address that is not valid gets the error page instead, so the browser never sends
 * the form away from this origin. Any other answer is unchanged.
 */
export function frameAnswer(result: unknown, page: URL, hop: number): unknown {
  if (!isFrameResponse(result) || !redirectStatuses.has(result.status)) return result
  const location = result.headers.get("location")
  if (location === null) return result
  result.body?.cancel().catch(() => undefined)
  const cookies = setCookiesOf(result.headers)
  const target = URL.canParse(location, page.href) ? new URL(location, page) : undefined
  if (!target || (target.protocol !== "http:" && target.protocol !== "https:")) {
    return frameError(502, "The page redirects to an address that is not valid, so the preview cannot show it.", cookies)
  }
  if (target.origin !== page.origin) {
    return frameError(502, `The page redirects to ${target.origin}, which is another site. The preview shows pages of this site only.`, cookies)
  }
  if (hop >= maximumFrameRedirects) {
    return frameError(502, `The page redirects more than ${maximumFrameRedirects} times, so the preview stopped.`, cookies)
  }
  // The fragment stays in the Location: the browser takes the one of the redirect, else it keeps the one it has.
  const parts = [...otherParameters(target.search), `${encodeURIComponent(contentPreviewFrameParameter)}=${hop + 1}`]
  target.search = `?${parts.join("&")}`
  const headers = new Headers(result.headers)
  for (const name of ["content-encoding", "content-length", "content-type", "transfer-encoding"]) headers.delete(name)
  headers.set("location", target.href)
  return new Response(null, { status: 307, headers })
}
