import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { authRequestEvent } from "./request.ts"

import type { AuthRequestInput } from "./types.ts"

/** The cookies that Better Auth set while a guard read the session of one request. */
export interface SessionCookies {
  /** The `Set-Cookie` values that no response carries yet. */
  pending: string[]
  /** Whether the prepared response of the request carries session cookies, so that its guards keep it private. */
  prepared: boolean
}

export function sendSessionCookies(input: AuthRequestInput, cookies: SessionCookies, response: Response): Response
export function sendSessionCookies(input: AuthRequestInput, cookies: SessionCookies): void
/**
 * Sends the cookies that Better Auth set while it read the session: the renewed session cookie after
 * `session.updateAge`, a refreshed cookie cache, or the deletion of an ended session. Without them the browser keeps
 * the old cookies and loses the session at their expiry, although the database extended it.
 *
 * H3 adds the prepared response of Standard Context to each response of the request: a returned value or Response,
 * and an error that the route throws. A plain Fetch host sends only the Response of the route, so the cookies go on
 * `response`, or, when the guard cannot see the response, in `res.headers` of Standard Context for the route to copy.
 *
 * A response with session cookies is `private`, so a shared cache cannot give one person's session to another.
 */
export function sendSessionCookies(input: AuthRequestInput, cookies: SessionCookies, response?: Response): Response | undefined {
  const standard = getStandardContext(authRequestEvent(input))
  if (response && standard.vendor === "fetch") {
    if (cookies.pending.length === 0) return response
    const sent = new Response(response.body, response)
    for (const cookie of cookies.pending.splice(0)) sent.headers.append("set-cookie", cookie)
    keepPrivate(sent.headers)
    return sent
  }
  const headers = standard.res.headers
  if (!headers) return response
  const pending = cookies.pending.splice(0)
  for (const cookie of pending) headers.append("set-cookie", cookie)
  if (pending.length > 0) cookies.prepared = true
  // H3 sends a Cache-Control of the prepared response over the one of a returned Response.
  if (cookies.prepared) keepPrivate(headers, response?.headers.get("cache-control"))
  return response
}

/**
 * Adds `private` to Cache-Control unless it already has `private` or `no-store`. The directives for the browser cache
 * stay, and `public` and `s-maxage`, which let a shared cache store the response, go.
 */
function keepPrivate(headers: Headers, responseCacheControl?: string | null): void {
  const directives = (headers.get("cache-control") ?? responseCacheControl ?? "").split(",").map(directive => directive.trim()).filter(Boolean)
  if (directives.some(directive => /^(?:private|no-store)\b/i.test(directive))) return
  const kept = directives.filter(directive => !/^(?:public|s-maxage)\b/i.test(directive))
  headers.set("cache-control", ["private", ...kept].join(", "))
}
