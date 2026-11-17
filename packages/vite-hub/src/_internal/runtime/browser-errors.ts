import { requestLog } from "@vite-hub/internal/runtime/request-log"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { getStandardContext } from "@vite-hub/runtime"

/** The largest report body. A report has one error, and its stack is cut to 4,000 characters. */
const maxBytes = 16 * 1024

/** Reports from one address in one minute, per server process. */
const perMinute = 20

const kinds = new Set(["error", "unhandledrejection", "chunk", "vue", "nuxt", "handled"])

/** The most fields a report can have. */
const maxFields = 20

const fieldName = /^[A-Za-z][\w.-]{0,39}$/

type BrowserReportField = string | number | boolean | null

/** One browser error or warning, as the server logs it. */
export interface BrowserErrorReport {
  /**
   * What caught it: the window `error`, `unhandledrejection`, or `vite:preloadError` (`chunk`) event, Nuxt's `vue:error`
   * and `app:error`, or `handled` for `reportBrowserError()`.
   */
  kind: string
  /** The page path, without its query or hash. */
  path: string
  /** Only a `handled` report can be a warning. */
  level: "error" | "warn"
  action?: string
  fields?: Record<string, BrowserReportField>
  /** How many fields the page or the server dropped because they were nested, extra, or badly named. */
  droppedFields?: number
  name: string
  message: string
  stack?: string
}

/**
 * The query and hash of each URL in a text: `?` or `#` after a path, and what follows. They hold searches and OAuth
 * codes. "Why?" keeps its `?` because no `/` comes before it.
 */
const urlQuery = /[?#](?<=\/[^\s"'`<>()?#]*[?#])[^\s"'`<>()]+/g

function cut(value: string, max: number): string {
  return value.slice(0, max * 2).replace(urlQuery, "").slice(0, max)
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? cut(value, max) : undefined
}

function isRecord(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * The first 20 flat values with plain names, each string cut to 300 characters, and how many other entries it dropped.
 * A nested value would let a page write any shape into the event. A bad entry does not drop the report: the page sends
 * each error once, so a refused report is lost.
 */
function parseFields(value: unknown): { fields: Record<string, BrowserReportField>, dropped: number } {
  if (!isRecord(value)) return { fields: {}, dropped: value === undefined ? 0 : 1 }
  const fields: Record<string, BrowserReportField> = {}
  let kept = 0
  let dropped = 0
  for (const [name, field] of Object.entries(value)) {
    const flat = typeof field === "string" || (typeof field === "number" && Number.isFinite(field)) || typeof field === "boolean" || field === null
    if (kept >= maxFields || !fieldName.test(name) || !flat) {
      dropped++
      continue
    }
    fields[name] = typeof field === "string" ? cut(field, 300) : field
    kept++
  }
  return { fields, dropped }
}

/** The count of fields that the page dropped before it sent the report. */
function pageDropped(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1000 ? value : 0
}

/** The report in a request body, with each field cut to size. `undefined` when the body is not a report. */
export function parseBrowserErrorReport(body: unknown): BrowserErrorReport | undefined {
  if (!isRecord(body)) return undefined
  const kind: unknown = Reflect.get(body, "kind")
  const path: unknown = Reflect.get(body, "path")
  const message = text(Reflect.get(body, "message"), 1000)
  if (typeof kind !== "string" || !kinds.has(kind) || typeof path !== "string" || !path.startsWith("/") || message === undefined) return undefined
  // A bad action, level, or field is ignored, never a reason to lose the report.
  const action = text(Reflect.get(body, "action"), 100)
  const { fields, dropped } = parseFields(Reflect.get(body, "fields"))
  const droppedFields = dropped + pageDropped(Reflect.get(body, "droppedFields"))
  const stack = text(Reflect.get(body, "stack"), 4000)
  return {
    kind,
    path: path.split(/[?#]/, 1)[0]!.slice(0, 300),
    // An uncaught error is always an error, whatever the page says.
    level: kind === "handled" && Reflect.get(body, "level") === "warn" ? "warn" : "error",
    ...(action ? { action } : {}),
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(droppedFields > 0 ? { droppedFields } : {}),
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

/**
 * Write the report into the request's wide event at its level, so it goes through the redaction, sampling, and drains
 * of the app's Evlog setup, next to the server's own events. Without Evlog, the server console gets it.
 */
function logReport(request: Request, report: BrowserErrorReport): void {
  const { kind, path, level, action, fields, droppedFields, name, message, stack } = report
  const log = requestLog(request)
  if (!log) {
    if (level === "warn") console.warn("[vitehub] Browser warning", report)
    else console.error("[vitehub] Browser error", report)
    return
  }
  const browserError = { kind, path, level, ...(action ? { action } : {}), ...(fields ? { fields } : {}), ...(droppedFields ? { droppedFields } : {}) }
  if (level === "warn") {
    log.warn(message, { browserError })
    return
  }
  const error = Object.assign(new Error(message), { name })
  error.stack = stack ?? `${name}: ${message}`
  log.error(error, { browserError })
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
