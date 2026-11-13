import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

import type { FormAnchor, FormRateLimit, FormRateLimitDecision } from "./types.ts"

const defaultRateLimit = { limit: 5, window: "1m" }
const defaultMaxBytes = 64 * 1024
const pageField = "_page"
const anchorField = "_anchor"

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
}

export function fail(status: number, message: string, headers?: Record<string, string>): Response {
  return json(status, { message }, headers)
}

type BodyKind = "json" | "form"

function bodyKind(request: Request): BodyKind | undefined {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (type === "application/json") return "json"
  if (type === "application/x-www-form-urlencoded" || type === "multipart/form-data") return "form"
  return undefined
}

/** Reads at most `limit` bytes, so a large body without `content-length` stops early. */
async function readBytes(request: Request, limit: number) {
  const declared = Number(request.headers.get("content-length") ?? 0)
  if (declared > limit) return undefined
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      // Do not wait for another branch when the host supplied a cloned request.
      reader.cancel().catch(() => {})
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function readBody(request: Request, kind: BodyKind, text: string): Promise<Record<string, unknown> | undefined> {
  if (kind === "json") {
    try {
      const value: unknown = JSON.parse(text)
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    }
    catch {
      return undefined
    }
  }
  let form: FormData | URLSearchParams
  try {
    form = request.headers.get("content-type")?.toLowerCase().startsWith("multipart/")
      ? await new Response(text, { headers: { "content-type": request.headers.get("content-type")! } }).formData()
      : new URLSearchParams(text)
  }
  catch {
    // A multipart body without its boundary, or a broken one.
    return undefined
  }
  const body: Record<string, unknown> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") return undefined
    const previous = body[key]
    body[key] = previous === undefined ? value : Array.isArray(previous) ? [...previous, value] : [previous, value]
  }
  return body
}

function appPath(value: unknown, request: Request): string | null {
  const raw = typeof value === "string" ? value : request.headers.get("referer")
  if (!raw) return null
  try {
    const origin = forwardedRequestOrigin(request)
    const url = new URL(raw, origin)
    if (url.origin !== origin) return null
    // The result of an earlier post without JavaScript, such as `contact.error`, is not part of the page. Another
    // `form` query of the app stays.
    if (/(^|\.)(sent|error)$/.test(url.searchParams.get("form") ?? "")) url.searchParams.delete("form")
    // One leading slash: `//evil.test` would be a link to another site.
    return `${url.pathname.replace(/^\/+/, "/")}${url.search}`.slice(0, 2000)
  }
  catch {
    return null
  }
}

function readAnchor(value: unknown): FormAnchor | null {
  let input = value
  if (typeof input === "string") {
    try {
      input = JSON.parse(input)
    }
    catch {
      return null
    }
  }
  if (!input || typeof input !== "object") return null
  const field = (key: string, limit: number) => {
    const raw: unknown = Reflect.get(input, key)
    return typeof raw === "string" ? raw.slice(0, limit) : ""
  }
  const selector = field("selector", 500)
  return selector ? { selector, exact: field("exact", 1000), prefix: field("prefix", 64), suffix: field("suffix", 64) } : null
}


function wantsPage(request: Request, kind: BodyKind): boolean {
  return kind === "form" && (request.headers.get("accept") ?? "").includes("text/html")
}

/**
 * A browser form without JavaScript goes back to its page, with `?form=<name>.sent` or `?form=<name>.error` when
 * `name` is set, else `?form=sent` or `?form=error`.
 */
export function back(request: Request, page: string | null, result: "sent" | "error", name?: string): Response {
  const url = new URL(page ?? "/", request.url)
  // The form name tells two forms on one page apart: `?form=contact.sent`.
  url.searchParams.set("form", name ? `${name}.${result}` : result)
  return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}`, "cache-control": "no-store" } })
}

export interface GuardRequestOptions {
  /** The rate limit key of this kind of request, such as `form:contact` or `comments:create`. */
  key: string
  /** Other origins that may post. The app's own origin may always post. */
  origins?: readonly string[]
  /** The name in the redirect of a browser form without JavaScript: `?form=<name>.sent` or `?form=<name>.error`. */
  name?: string
  /** A field that people leave empty and bots fill. Default `website`. `false` turns it off. */
  honeypot?: string | false
  /** Largest body in bytes. Default 64 KB. */
  maxBytes?: number
  /** Default `{ limit: 5, window: "1m" }`. `false` turns it off. */
  rateLimit?: FormRateLimit | false
  /**
   * Access checks of the app, such as sign-in. They run after the origin and body size checks, before the rate limit
   * and body parsing, so a refused request uses no rate budget. The check gets a copy with the bounded body, so it can
   * read the body. Return a status and a message to stop the request.
   */
  check?: (request: Request) => Promise<{ status: number, message: string } | undefined> | { status: number, message: string } | undefined
}

export interface GuardRequestServices {
  rateLimit?: (request: Request, key: string, policy: FormRateLimit) => Promise<FormRateLimitDecision>
}

/** A request that passed the guard. */
export interface GuardedRequest {
  /** The fields of the body, without `_page`, `_anchor`, and the honeypot. */
  body: Record<string, unknown>
  /** The app path that the request came from: `_page`, else the `Referer`, when it is on the app's origin. */
  page: string | null
  anchor: FormAnchor | null
  /** A browser form without JavaScript: answer it with a redirect back to `page`. */
  html: boolean
}

/**
 * The checks of a public write, before the app reads the body: `POST`, a JSON, URL-encoded, or multipart body, the
 * origin, the size, the `check` of the app, the rate limit, and the honeypot. Returns `[response]` when a check stops the request, else
 * `[undefined, guarded]`. A filled honeypot answers like a success, so a bot does not try again.
 */
export async function guardRequest(request: Request, options: GuardRequestOptions, services: GuardRequestServices = {}): Promise<[Response, undefined] | [undefined, GuardedRequest]> {
  if (request.method !== "POST") return [fail(405, "Use POST.", { allow: "POST" }), undefined]
  const kind = bodyKind(request)
  if (!kind) return [fail(415, "Send JSON or form data."), undefined]
  const origin = request.headers.get("origin")
  // Behind a proxy that ends TLS, `request.url` is `http:` while the browser sends its `https:` origin.
  if (origin && origin !== forwardedRequestOrigin(request) && !options.origins?.includes(origin)) return [fail(403, "This origin may not send this form."), undefined]
  const html = wantsPage(request, kind)
  // A browser form without JavaScript goes back to its page on every failure, not to a JSON answer.
  const stop = (status: number, message: string, headers?: Record<string, string>): [Response, undefined] => [html ? back(request, appPath(undefined, request), "error", options.name) : fail(status, message, headers), undefined]
  const bytes = await readBytes(request, options.maxBytes ?? defaultMaxBytes)
  if (bytes === undefined) return stop(413, "The message is too large.")
  // Bound the raw bytes before a callback can consume them. Keep the bytes intact for native body readers.
  // Nitro's Node request adapter has no native Request internal state; copy its public fields.
  const refused = await options.check?.(new Request(request.url, {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
    body: bytes,
  }))
  if (refused) return stop(refused.status, refused.message)
  const rateLimit = options.rateLimit === false ? undefined : options.rateLimit ?? defaultRateLimit
  if (rateLimit && services.rateLimit) {
    const decision = await services.rateLimit(request, options.key, rateLimit)
    if (!decision.allowed) return stop(429, "Too many messages. Try again later.", decision.retryAfter ? { "retry-after": String(Math.ceil(decision.retryAfter)) } : undefined)
  }
  const raw = await readBody(request, kind, new TextDecoder().decode(bytes))
  if (!raw) return stop(400, "The body is not a form.")
  const page = appPath(raw[pageField], request)
  const honeypot = options.honeypot === false ? undefined : options.honeypot ?? "website"
  const trap = honeypot ? raw[honeypot] : undefined
  if (typeof trap === "string" && trap.trim()) return [html ? back(request, page, "sent", options.name) : json(202, { ok: true }), undefined]
  const body = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== pageField && key !== anchorField && key !== honeypot))
  return [undefined, { body, page, anchor: readAnchor(raw[anchorField]), html }]
}
