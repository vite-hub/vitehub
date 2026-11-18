import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { getStandardContext } from "@vite-hub/runtime"

/** The largest report body. A report has one error, and its stack is cut to 4,000 characters. */
const maxBytes = 16 * 1024

/** Reports from one address in one minute, per server process. */
const perMinute = 20

const kinds = new Set(["error", "unhandledrejection", "vue", "nuxt"])

/** One browser error, as the server logs it. */
export interface BrowserErrorReport {
  /** The browser event that caught the error: `error`, `unhandledrejection`, or Nuxt's `vue:error` and `app:error`. */
  kind: string
  /** The page path, without its query or hash. */
  path: string
  name: string
  message: string
  stack?: string
}

/**
 * The query and hash of each URL in a text: `?` or `#` after a path, and what follows. They hold searches and OAuth
 * codes. "Why?" keeps its `?` because no `/` comes before it.
 */
const urlQuery = /[?#](?<=\/[^\s"'`<>()?#]*[?#])[^\s"'`<>()]+/g

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max * 2).replace(urlQuery, "").slice(0, max) : undefined
}

/** The report in a request body, with each field cut to size. `undefined` when the body is not a report. */
export function parseBrowserErrorReport(body: unknown): BrowserErrorReport | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined
  const kind: unknown = Reflect.get(body, "kind")
  const path: unknown = Reflect.get(body, "path")
  const message = text(Reflect.get(body, "message"), 1000)
  if (typeof kind !== "string" || !kinds.has(kind) || typeof path !== "string" || !path.startsWith("/") || message === undefined) return undefined
  const stack = text(Reflect.get(body, "stack"), 4000)
  return {
    kind,
    path: path.split(/[?#]/, 1)[0]!.slice(0, 300),
    name: text(Reflect.get(body, "name"), 120) || "Error",
    message,
    ...(stack ? { stack } : {}),
  }
}

/**
 * A request from a page of this app: `Sec-Fetch-Site` is `same-origin` when the browser sends it, and `Origin` is the
 * origin of the request. Other sites and clients without `Origin` get 403. The check only stops other sites: a script
 * outside a browser can send any header.
 */
function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site")
  if (site && site !== "same-origin") return false
  return request.headers.get("origin") === forwardedRequestOrigin(request)
}

function clientAddress(request: Request): string {
  const runtime = getStandardContext(request).runtime
  return runtime?.clientAddress ?? (runtime?.cloudflare ? request.headers.get("cf-connecting-ip") : null) ?? "unknown"
}

/** Counts reports for each address in fixed one-minute windows, in this server process. */
function minuteLimit(now: () => number): (key: string) => number | undefined {
  const windows = new Map<string, { count: number, resetAt: number }>()
  return (key) => {
    const time = now()
    if (windows.size > 10_000) {
      for (const [stale, entry] of windows) if (entry.resetAt <= time) windows.delete(stale)
    }
    const current = windows.get(key)
    const entry = current && current.resetAt > time ? current : { count: 0, resetAt: time + 60_000 }
    entry.count += 1
    windows.set(key, entry)
    return entry.count > perMinute ? Math.ceil((entry.resetAt - time) / 1000) : undefined
  }
}

interface RequestLogger {
  error: (error: Error, context: Record<string, unknown>) => void
}

/** Evlog's Nitro plugin puts the wide event of each request on `request.context.log`. */
function requestLogger(request: Request): RequestLogger | undefined {
  const context: unknown = Reflect.get(request, "context")
  const log: unknown = context !== null && typeof context === "object" ? Reflect.get(context, "log") : undefined
  if (log === null || typeof log !== "object") return undefined
  const error: unknown = Reflect.get(log, "error")
  return typeof error === "function" ? { error: (value, fields) => Reflect.apply(error, log, [value, fields]) } : undefined
}

/**
 * Write the report into the request's wide event at error level, so it goes through the redaction, sampling, and drains
 * of the app's Evlog setup, next to the server's own events. Without Evlog, the server console gets it.
 */
function logReport(request: Request, report: BrowserErrorReport): void {
  const { kind, path, name, message, stack } = report
  const log = requestLogger(request)
  if (!log) {
    console.error("[vitehub] Browser error", report)
    return
  }
  const error = Object.assign(new Error(message), { name })
  error.stack = stack ?? `${name}: ${message}`
  log.error(error, { browserError: { kind, path } })
}

/**
 * The body as text, or `undefined` when it passes `maxBytes`. It stops reading and cancels the body at the limit, so a
 * body without `Content-Length` cannot make the server hold more than that.
 */
async function readBoundedText(request: Request): Promise<string | undefined> {
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
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
  return new TextDecoder().decode(bytes)
}

function reply(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } })
}

/** The `{ fetch }` handler of `POST <base>/api/_vitehub/browser-errors`. `now` is for tests. */
export function createBrowserErrorsHandler(now: () => number = Date.now): { fetch: (request: Request) => Promise<Response> } {
  const limit = minuteLimit(now)
  return {
    async fetch(request) {
      if (!sameOrigin(request)) return reply(403)
      const retryAfter = limit(clientAddress(request))
      if (retryAfter !== undefined) return reply(429, { "retry-after": String(retryAfter) })
      if (Number(request.headers.get("content-length")) > maxBytes) return reply(413)
      const body = await readBoundedText(request)
      if (body === undefined) return reply(413)
      let json: unknown
      try {
        json = JSON.parse(body)
      }
      catch {
        return reply(400)
      }
      const report = parseBrowserErrorReport(json)
      if (!report) return reply(400)
      logReport(request, report)
      return reply(204)
    },
  }
}

const handler: { fetch: (request: Request) => Promise<Response> } = createBrowserErrorsHandler()

export default handler
