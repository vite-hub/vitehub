import { Diagnostic } from "nostics"

import { consoleRpcHeader } from "../rpc"

import { consoleDiagnostic, consoleDiagnosticAction, consoleStatusDiagnosticCode, isConsoleDiagnosticCode } from "../diagnostics"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

const consoleApiMarker = "/api/_vitehub/console/"
const consoleRpcCallPath = "/_vitehub/rpc/__call"
const consoleRpcUploadPath = "/_vitehub/rpc/__upload"

function decodeConsoleId(value: string): string {
  try {
    return decodeURIComponent(value)
  }
  catch {
    throw new ConsoleRequestError(400, "Malformed invocation id.")
  }
}

/** The diagnostic fields of a failed Console response. All are optional because the body is untrusted. */
export interface ConsoleErrorFields {
  code?: string
  docs?: string
  fix?: string
  message?: string
}

/**
 * A failed Console or management response. `code` is the server code, or the Console code of the status when the
 * response has none. `fix` and `docs` come from the server, or from the Console catalog for a Console code.
 */
export class ConsoleRequestError extends Diagnostic {
  readonly status: number
  /** Stable failure code of an owner action, such as `CONTENT_INVALID` or `WORKSPACE_CONFLICT`. */
  readonly failureCode?: string
  /** JSON details of an owner action failure, such as per-field issues. */
  readonly details?: Record<string, unknown>

  /**
   * `fields` is the diagnostic body, or only its message. `failure` carries the code and JSON details of an owner
   * action failure, which forms read to show field issues and conflicts.
   */
  constructor(status: number, fields: ConsoleErrorFields | string = {}, failure: { code?: string, details?: Record<string, unknown> } = {}) {
    const body: ConsoleErrorFields = fields instanceof Object ? fields : { message: fields }
    const code = body.code || failure.code || consoleStatusDiagnosticCode(status)
    const known = isConsoleDiagnosticCode(code) ? consoleDiagnostic(code, body.message) : undefined
    super({
      code,
      docs: body.docs || known?.docs,
      fix: body.fix || known?.fix,
      why: body.message?.trim() || known?.message || `Console request failed with status ${status}.`,
    }, ConsoleRequestError)
    this.name = "ConsoleRequestError"
    this.status = status
    if (failure.code !== undefined) this.failureCode = failure.code
    if (failure.details !== undefined) this.details = failure.details
  }
}

/** Whether a Console request failed because no one is signed in, such as with `auth: "app"` after the session ended. */
export function isConsoleSignInRequired(error: unknown): boolean {
  return error instanceof ConsoleRequestError && error.status === 401
}

const textField = (value: unknown): string | undefined =>
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  typeof value === "string" && value.trim() ? value.slice(0, 1_000) : undefined

/** Read the diagnostic fields of an untrusted error body. Accepts `{ code, message }` and `{ error: { code, message } }`. */
export function consoleErrorFields(value: unknown): ConsoleErrorFields {
  const body = record(value)
  const nested = record(body?.error)
  const source = nested ?? body
  const docs = textField(source?.docs)
  return {
    code: textField(source?.code),
    // The Console renders `docs` as a link, so it accepts only HTTPS URLs.
    docs: docs?.startsWith("https://") ? docs : undefined,
    fix: textField(source?.fix),
    message: textField(source?.message),
  }
}

function consoleFailureFields(value: unknown): { code?: string, details?: Record<string, unknown> } {
  const body = record(value)
  return {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    code: typeof body?.code === "string" ? body.code : undefined,
    details: record(body?.details),
  }
}

/** Read a failed response into a `ConsoleRequestError`. A short plain-text body, such as one from host middleware, becomes the why. */
export async function consoleResponseError(response: Response, fallback: ConsoleErrorFields = {}): Promise<ConsoleRequestError> {
  const text = await response.text().catch(() => "")
  let fields: ConsoleErrorFields = {}
  let failure: ReturnType<typeof consoleFailureFields> = {}
  try {
    const body: unknown = JSON.parse(text)
    fields = consoleErrorFields(body)
    failure = consoleFailureFields(body)
  }
  catch {
    const plain = response.headers.get("content-type")?.startsWith("text/plain") ? text.trim() : ""
    if (plain && plain.length <= 300) fields = { message: plain }
  }
  return new ConsoleRequestError(response.ok ? 502 : response.status, {
    code: fields.code ?? fallback.code,
    docs: fields.docs ?? fallback.docs,
    fix: fields.fix ?? fallback.fix,
    message: fields.message ?? fallback.message,
  }, failure)
}

/** The media upload route under the application mount of a Console API path. */
export function consoleRpcUploadURL(path: string): string {
  const url = new URL(path, "http://vitehub.local")
  const marker = url.pathname.lastIndexOf(consoleApiMarker)
  const appBase = marker === -1 ? "" : url.pathname.slice(0, marker)
  return `${appBase}${consoleRpcUploadPath}`
}

function consoleRpcCallURL(path: string): string {
  const url = new URL(path, "http://vitehub.local")
  // The application mount may itself contain the Console API marker. The
  // final marker is the generated route that belongs to this request.
  const marker = url.pathname.lastIndexOf(consoleApiMarker)
  const appBase = marker === -1 ? "" : url.pathname.slice(0, marker)
  return `${appBase}${consoleRpcCallPath}`
}

interface ConsoleRoute {
  /** Query keys that the operation takes as flags, with the value that means on. */
  booleans?: Record<string, string>
  lists?: string[]
  numbers?: string[]
  operation: string
  strings?: string[]
}

// The Console views still ask for the former route paths. Each one maps to a named operation and its typed input.
const consoleRoutes: Record<string, ConsoleRoute> = {
  "agents": { operation: "agents.list" },
  "blob": { booleans: { folded: "true", showVitehub: "true" }, numbers: ["limit"], operation: "blob.list", strings: ["cursor", "prefix", "store"] },
  "database": { numbers: ["limit", "offset"], operation: "databases.browse", strings: ["database", "direction", "search", "sort", "table"] },
  "definitions": { operation: "definitions.list", strings: ["section"] },
  "env": { booleans: { status: "1" }, operation: "env.get" },
  "invocation-capabilities": { operation: "invocations.capabilities", strings: ["agent"] },
  "invocations": { lists: ["id"], numbers: ["limit"], operation: "invocations.list", strings: ["agent", "capability", "cursor", "triggeredBy"] },
  "sections": { operation: "sections.list" },
  "search": { numbers: ["limit"], operation: "search.query", strings: ["cursor", "search"] },
  "skills": { operation: "skills.inspect", strings: ["agent", "path"] },
  "status": { operation: "status.get", strings: ["agent"] },
  "logs": { operation: "logs.list", numbers: ["limit"], strings: ["text", "level", "service", "cursor"] },
  "usage": { operation: "usage.get", strings: ["agent", "cursor", "search", "status", "window"] },
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function inputFromQuery(route: ConsoleRoute, query: Record<string, string | string[]>): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  for (const key of route.strings ?? []) {
    const value = first(query[key])
    if (value !== undefined) input[key] = value
  }
  for (const key of route.numbers ?? []) {
    const value = first(query[key])
    if (value !== undefined) input[key] = value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : value
  }
  for (const key of route.lists ?? []) {
    const value = query[key]
    if (value !== undefined) input[key] = Array.isArray(value) ? value : [value]
  }
  for (const [key, on] of Object.entries(route.booleans ?? {})) {
    const value = first(query[key])
    if (value !== undefined) input[key] = value === on
  }
  return input
}

/** The named operation and typed input of one Console route call. */
export function consoleOperationCall(path: string, call: { body?: unknown, method: "GET" | "POST", query: Record<string, string | string[]> }): { input: Record<string, unknown>, operation: string } {
  const url = new URL(path, "http://vitehub.local")
  const marker = url.pathname.lastIndexOf(consoleApiMarker)
  const route = marker === -1 ? "" : url.pathname.slice(marker + consoleApiMarker.length)
  const body = record(call.body) ?? {}
  const agentInvocationMatch = /^agents\/([^/]+)\/invocations$/.exec(route)
  if (agentInvocationMatch) {
    return { input: { ...body, agent: agentInvocationMatch[1]!, ...(first(call.query.agentRoute) === "encoded" ? { agentRoute: "encoded" } : {}) }, operation: "agents.invoke" }
  }
  const workspaceMatch = /^invocations\/([^/]+)\/workspace$/.exec(route)
  if (workspaceMatch) {
    const input: Record<string, unknown> = { id: decodeConsoleId(workspaceMatch[1]!) }
    for (const key of ["cursor", "path", "ref", "revision"]) if (first(call.query[key]) !== undefined) input[key] = first(call.query[key])
    if (first(call.query.history) !== undefined) input.history = first(call.query.history) === "1"
    return { input, operation: "invocations.workspace" }
  }
  if (route.startsWith("invocations/")) {
    const id = decodeConsoleId(route.slice("invocations/".length))
    if (call.method === "POST") {
      if (body.action !== "cancel" && body.action !== "delete") throw new ConsoleRequestError(400, "Unsupported invocation action.")
      return { input: { id }, operation: `invocations.${body.action}` }
    }
    const input: Record<string, unknown> = { id }
    const count = first(call.query.observationCount)
    if (count !== undefined) input.observationCount = count.trim() !== "" && Number.isFinite(Number(count)) ? Number(count) : count
    if (first(call.query.observationCursor) !== undefined) input.observationCursor = first(call.query.observationCursor)
    return { input, operation: "invocations.get" }
  }
  if (route === "documents" || route === "media") {
    return { input: { action: first(call.query.action), ...(call.body === undefined ? {} : { body: call.body }), section: first(call.query.section) }, operation: `${route}.action` }
  }
  if (route === "kv") {
    if (call.method === "POST") return { input: body, operation: "kv.get" }
    return { input: inputFromQuery({ numbers: ["limit"], operation: "kv.list", strings: ["cursor", "prefix", "store"] }, call.query), operation: "kv.list" }
  }
  if (route === "schedule-run") return { input: body, operation: "schedules.run" }
  const known = Object.hasOwn(consoleRoutes, route) ? consoleRoutes[route] : undefined
  if (!known) throw new ConsoleRequestError(404, "Console operation not found.")
  return { input: inputFromQuery(known, call.query), operation: known.operation }
}

/** A fetch failure known to originate at the network boundary. */
export class ConsoleNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Console network request failed.", { cause })
    this.name = "ConsoleNetworkError"
  }
}

export function isRetryableConsoleRequestError(error: unknown): boolean {
  if (!(error instanceof ConsoleRequestError)) return error instanceof ConsoleNetworkError
  const transientStatus = error.status === 408 || error.status === 429 || error.status === 500 || (error.status >= 502 && error.status <= 504)
  if (isConsoleDiagnosticCode(error.code)) return transientStatus && consoleDiagnosticAction(error.code) === "retry"
  return transientStatus
}

export async function requestConsole(
  path: string,
  options: {
    body?: unknown
    method?: "GET" | "POST"
    /** Let the request finish after the page unloads, such as a release sent on `pagehide`. */
    keepalive?: boolean
    query?: Record<string, unknown>
    signal?: AbortSignal
  } = {},
): Promise<unknown> {
  const url = new URL(path, "http://vitehub.local")
  const query: Record<string, string | string[]> = {}
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key)
    query[key] = values.length === 1 ? values[0]! : values
  }
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue
    query[key] = Array.isArray(value) ? value.map(String) : String(value)
  }
  const call = consoleOperationCall(path, { body: options.body, method: options.method ?? "GET", query })
  // Each call is one complete request, so hosts can route consecutive calls to different instances.
  // The operation comes first so the server can find large calls within the first bytes.
  const requestBody = JSON.stringify({ operation: call.operation, input: call.input })
  let response: Response
  try {
    response = await fetch(consoleRpcCallURL(path), {
      body: requestBody,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
      ...(options.keepalive ? { keepalive: true } : {}),
      method: "POST",
      signal: options.signal,
    })
  }
  catch (error) {
    // Aborted requests are intentional (for example when a view unmounts); preserve
    // the original error so callers that ignore AbortError can do so reliably.
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ConsoleNetworkError(error)
  }
  if (!response.ok) throw await consoleResponseError(response)
  const result = record(await response.json().catch(() => undefined))
  if (result?.ok === true) return result.value
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  const status = typeof result?.status === "number" && result.status >= 400 ? result.status : response.ok ? 502 : response.status
  throw new ConsoleRequestError(status, consoleErrorFields(result), consoleFailureFields(result))
}

export function appendUniqueConsoleKeys(existing: string[], page: string[]): string[] {
  return [...new Set([...existing, ...page])]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function assertConsolePage(page: Record<string, unknown>): void {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  const message = typeof page.error === "string" ? page.error : undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  const code = typeof page.errorCode === "string" ? page.errorCode : undefined
  if (!message && !code) return
  const error = viteHubErrorDiagnostics.VITE_HUB_R0041({ message: message ?? `Console request failed with error code ${code}.` })
  if (code) Object.assign(error, { code })
  throw error
}

export async function loadConsoleKVPages(
  base: string,
  store: string,
  signal: AbortSignal,
  initial?: Record<string, unknown>,
  options: { limit?: number; maxPages?: number; prefix?: string } = {},
): Promise<{ pages: Record<string, unknown>[]; truncated: boolean }> {
  const pages: Record<string, unknown>[] = []
  const cursors = new Set<string>()
  let page = initial
  let hasMore = true
  while (hasMore && pages.length < (options.maxPages ?? Number.POSITIVE_INFINITY)) {
    page ??= record(
      await requestConsole(base, {
        query: { limit: options.limit, prefix: options.prefix, store },
        signal,
      }),
    )
    if (!page) break
    assertConsolePage(page)
    pages.push(page)
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
    const cursor = typeof page.cursor === "string" ? page.cursor : undefined
    if (cursor === undefined) {
      hasMore = false
      continue
    }
    if (cursors.has(cursor)) break
    cursors.add(cursor)
    if (pages.length >= (options.maxPages ?? Number.POSITIVE_INFINITY)) break
    page = record(
      await requestConsole(base, {
        query: { cursor, limit: options.limit, prefix: options.prefix, store },
        signal,
      }),
    )
  }
  return { pages, truncated: hasMore }
}
