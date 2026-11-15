import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { authRequestEvent } from "./request.ts"
import { readSetCookies } from "./set-cookie.ts"

import type { ViteHubStandardProps } from "@vite-hub/runtime/internal/h3"
import type { AuthRequestInput } from "./types.ts"

/** The session cookies of one request that are in its prepared response, and the Cache-Control that they need. */
interface PreparedSessionCookies {
  cookies: string[]
  /** The Cache-Control that the guards wrote in the prepared response, and the value that it replaced. */
  cacheControl?: { replaced: string | null, written: string }
}

// The key is the Standard Context, which the request event, its Request, and the copies of the Request share.
const preparedSessionCookies = new WeakMap<ViteHubStandardProps, PreparedSessionCookies>()

/**
 * Puts the cookies that Better Auth set while it read the session in the prepared response of the request: the renewed
 * session cookie after `session.updateAge`, a refreshed cookie cache, or the deletion of an ended session. Without them
 * the browser keeps the old cookies and loses the session at their expiry, although the database extended it.
 *
 * Guards call this right after the read, so the cookies also go with a refusal or an error that comes later. H3 adds
 * the prepared response to each response of the request. On a plain Fetch host, `sendSessionCookies()` moves them to
 * the Response of a guard, and a route without one copies `res.headers` of Standard Context.
 *
 * A response with session cookies must stay out of shared caches. The guard cannot see the Cache-Control of the route
 * here, so it asks for `no-store`, which no directive of the route is stricter than. `sendSessionCookies()` asks for
 * `private` when it sees the response.
 */
export function prepareSessionCookies(input: AuthRequestInput, setCookies: readonly string[]): void {
  if (setCookies.length === 0) return
  const standard = getStandardContext(authRequestEvent(input))
  let prepared = preparedSessionCookies.get(standard)
  if (!prepared) preparedSessionCookies.set(standard, prepared = { cookies: [] })
  // A later read of the same request replaces a cookie of the same name.
  const names = new Set(setCookies.map(cookieName))
  const replaced = prepared.cookies.filter(cookie => names.has(cookieName(cookie)))
  prepared.cookies = [...prepared.cookies.filter(cookie => !names.has(cookieName(cookie))), ...setCookies]
  const headers = standard.res.headers
  if (!headers) return
  removeSetCookies(headers, replaced)
  for (const cookie of setCookies) headers.append("set-cookie", cookie)
  writeCacheControl(headers, prepared)
}

/**
 * The last step of a guard that sees the outcome of the request: a refusal, or the value or Response of the route.
 *
 * A plain Fetch host sends only this Response, so the session cookies move from the prepared response to a copy of
 * it, once, also for a Response of another Fetch implementation, such as `undici`. H3 adds the prepared response to
 * the outcome itself. In both, a cookie that the Response sets itself wins over the session cookie of the same name,
 * and the Cache-Control of the route becomes `private`, unless it already has `private` or `no-store`.
 */
export function sendSessionCookies<T>(input: AuthRequestInput, outcome: T): T | Response {
  const standard = getStandardContext(authRequestEvent(input))
  const prepared = preparedSessionCookies.get(standard)
  if (!prepared) return outcome
  const response = isResponseLike(outcome) ? outcome : undefined
  const headers = standard.res.headers
  if (standard.vendor === "fetch") {
    if (!response) return outcome
    preparedSessionCookies.delete(standard)
    if (headers) {
      removeSetCookies(headers, prepared.cookies)
      if (prepared.cacheControl && headers.get("cache-control") === prepared.cacheControl.written) {
        const { replaced } = prepared.cacheControl
        if (replaced === null) headers.delete("cache-control")
        else headers.set("cache-control", replaced)
      }
    }
    return withSessionCookies(response, prepared.cookies)
  }
  if (!headers) return outcome
  if (response) {
    const own = new Set(readSetCookies(response.headers).map(cookieName))
    removeSetCookies(headers, prepared.cookies.filter(cookie => own.has(cookieName(cookie))))
    prepared.cookies = prepared.cookies.filter(cookie => !own.has(cookieName(cookie)))
  }
  // H3 sends a value that is not a Response without a Cache-Control of its own.
  writeCacheControl(headers, prepared, response?.headers.get("cache-control") ?? null)
  return outcome
}

function withSessionCookies(response: Response, cookies: readonly string[]): Response {
  const own = new Set(readSetCookies(response.headers).map(cookieName))
  const missing = cookies.filter(cookie => !own.has(cookieName(cookie)))
  const cacheControl = privateCacheControl(response.headers.get("cache-control"))
  if (missing.length === 0 && cacheControl === response.headers.get("cache-control") && response instanceof Response) return response
  const sent = new Response(response.body, { headers: response.headers, status: response.status, statusText: response.statusText })
  for (const cookie of missing) sent.headers.append("set-cookie", cookie)
  sent.headers.set("cache-control", cacheControl)
  return sent
}

/**
 * Writes the Cache-Control of a response with session cookies in the prepared response. H3 sends the prepared value
 * over the one of the route, so the policy starts from the value that the response would have without the guards:
 * a prepared value that someone else wrote, else the value of the route. `route` is `undefined` when no guard has
 * seen the response yet.
 */
function writeCacheControl(headers: Headers, prepared: PreparedSessionCookies, route?: string | null): void {
  const current = headers.get("cache-control")
  const base = prepared.cacheControl && current === prepared.cacheControl.written ? prepared.cacheControl.replaced : current
  const value = base ?? route
  const written = value === undefined ? "no-store" : privateCacheControl(value)
  if (written !== current) headers.set("cache-control", written)
  prepared.cacheControl = { replaced: base, written }
}

/**
 * Adds `private` to Cache-Control unless it already has `private` or `no-store`. The directives for the browser cache
 * stay, and `public` and `s-maxage`, which let a shared cache store the response, go.
 */
function privateCacheControl(value: string | null): string {
  const directives = (value ?? "").split(",").map(directive => directive.trim()).filter(Boolean)
  if (directives.some(directive => /^(?:private|no-store)\b/i.test(directive))) return value ?? ""
  return ["private", ...directives.filter(directive => !/^(?:public|s-maxage)\b/i.test(directive))].join(", ")
}

function cookieName(setCookie: string): string {
  const end = setCookie.search(/[=;]/)
  return (end < 0 ? setCookie : setCookie.slice(0, end)).trim()
}

/** Removes these exact `Set-Cookie` values, once each, and keeps the others in their order. */
function removeSetCookies(headers: Headers, values: readonly string[]): void {
  if (values.length === 0) return
  const remove = [...values]
  const kept = readSetCookies(headers).filter((cookie) => {
    const index = remove.indexOf(cookie)
    if (index < 0) return true
    remove.splice(index, 1)
    return false
  })
  headers.delete("set-cookie")
  for (const cookie of kept) headers.append("set-cookie", cookie)
}

/** A Response of this runtime, or of another Fetch implementation, such as `undici`. */
function isResponseLike(value: unknown): value is Response {
  if (value instanceof Response) return true
  if (value === null || typeof value !== "object") return false
  try {
    if (Object.prototype.toString.call(value) !== "[object Response]") return false
    const status: unknown = Reflect.get(value, "status")
    const headers: unknown = Reflect.get(value, "headers")
    return typeof status === "number"
      && typeof Reflect.get(value, "statusText") === "string"
      && typeof headers === "object" && headers !== null
      && typeof Reflect.get(headers, "get") === "function"
  }
  catch {
    return false
  }
}
