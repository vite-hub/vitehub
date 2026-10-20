import { Diagnostic } from "nostics"

import { consoleRpcHeader, consoleRpcMethods } from "../rpc"

import type { ConsoleRpcInput, ConsoleRpcMethod } from "../rpc"
import { consoleDiagnostic, consoleDiagnosticAction, consoleStatusDiagnosticCode, isConsoleDiagnosticCode } from "../diagnostics"
import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"

const consoleApiMarker = "/api/_vitehub/console/"
const consoleRpcCallPath = "/_vitehub/rpc/__call"

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

  constructor(status: number, fields: ConsoleErrorFields | string = {}) {
    const body: ConsoleErrorFields = fields instanceof Object ? fields : { message: fields }
    const code = body.code || consoleStatusDiagnosticCode(status)
    const known = isConsoleDiagnosticCode(code) ? consoleDiagnostic(code, body.message) : undefined
    super({
      code,
      docs: body.docs || known?.docs,
      fix: body.fix || known?.fix,
      why: body.message?.trim() || known?.message || `Console request failed with status ${status}.`,
    }, ConsoleRequestError)
    this.name = "ConsoleRequestError"
    this.status = status
  }
}

const textField = (value: unknown): string | undefined =>
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

/** Read a failed response into a `ConsoleRequestError`. A short plain-text body, such as one from host middleware, becomes the why. */
export async function consoleResponseError(response: Response, fallback: ConsoleErrorFields = {}): Promise<ConsoleRequestError> {
  const text = await response.text().catch(() => "")
  let fields: ConsoleErrorFields = {}
  try {
    fields = consoleErrorFields(JSON.parse(text))
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
  })
}

function consoleRpcCallURL(path: string): string {
  const url = new URL(path, "http://vitehub.local")
  // The application mount may itself contain the Console API marker. The
  // final marker is the generated route that belongs to this request.
  const marker = url.pathname.lastIndexOf(consoleApiMarker)
  const appBase = marker === -1 ? "" : url.pathname.slice(0, marker)
  return `${appBase}${consoleRpcCallPath}`
}

function consoleRpcCall(path: string): { agent?: string; id?: string; method: ConsoleRpcMethod } {
  const url = new URL(path, "http://vitehub.local")
  const marker = url.pathname.lastIndexOf(consoleApiMarker)
  const operation = marker === -1 ? "" : url.pathname.slice(marker + consoleApiMarker.length)
  const agentInvocationMatch = /^agents\/([^/]+)\/invocations$/.exec(operation)
  if (agentInvocationMatch) {
    return {
      agent: agentInvocationMatch[1]!,
      method: consoleRpcMethods.agentInvocations,
    }
  }
  const workspaceMatch = /^invocations\/([^/]+)\/workspace$/.exec(operation)
  if (workspaceMatch) return { id: decodeConsoleId(workspaceMatch[1]!), method: consoleRpcMethods.invocationWorkspace }
  if (operation.startsWith("invocations/")) {
    return {
      id: decodeConsoleId(operation.slice("invocations/".length)),
      method: consoleRpcMethods.invocation,
    }
  }
  const key = operation.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
  const method = Object.entries(consoleRpcMethods).find(([name]) => name === key)?.[1]
  if (!method) throw new ConsoleRequestError(404, "Console operation not found.")
  return { method }
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
  const call = consoleRpcCall(path)
  const input: ConsoleRpcInput = { method: options.method ?? "GET", query }
  if (call.agent !== undefined) input.agent = call.agent
  if (call.id !== undefined) input.id = call.id
  if (options.body !== undefined) input.body = options.body
  // Each call is one complete request, so hosts can route consecutive calls to different instances.
  const requestBody = JSON.stringify({ method: call.method, input })
  let response: Response
  try {
    response = await fetch(consoleRpcCallURL(path), {
      body: requestBody,
      cache: "no-store",
      credentials: "same-origin",
      headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
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
  const status = typeof result?.status === "number" && result.status >= 400 ? result.status : 502
  throw new ConsoleRequestError(status, consoleErrorFields(result))
}

export function appendUniqueConsoleKeys(existing: string[], page: string[]): string[] {
  return [...new Set([...existing, ...page])]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function assertConsolePage(page: Record<string, unknown>): void {
  const message = typeof page.error === "string" ? page.error : undefined
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
