import { Diagnostic } from "nostics"

import { consoleRpcHeader, consoleRpcMethods } from "../rpc"

import type { ConsoleRpcInput, ConsoleRpcMethod } from "../rpc"
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

export class ConsoleRequestError extends Diagnostic {
  readonly status: number
  /** Stable failure code of an owner action, such as `CONTENT_INVALID` or `WORKSPACE_CONFLICT`. */
  readonly failureCode?: string
  /** JSON details of an owner action failure, such as per-field issues. */
  readonly details?: Record<string, unknown>

  constructor(status: number, fields: { code?: string; docs?: string; fix?: string; message?: string; failureCode?: string; details?: Record<string, unknown> } | string = {}, failure: { code?: string; details?: Record<string, unknown> } = {}) {
    const body = typeof fields === "string" ? { message: fields, failureCode: failure.code, details: failure.details } : fields
    super({ code: body.code ?? "VITE_HUB_R0110", docs: body.docs ?? "https://vitehub.dev/docs/reference/diagnostics", fix: body.fix, why: body.message ?? `Console request failed with status ${status}.` }, ConsoleRequestError)
    this.name = "ConsoleRequestError"
    this.status = status
    if (body.failureCode !== undefined) this.failureCode = body.failureCode
    if (body.details !== undefined) this.details = body.details
  }
}

function consoleAppBase(path: string): string {
  const url = new URL(path, "http://vitehub.local")
  // The application mount may itself contain the Console API marker. The
  // final marker is the generated route that belongs to this request.
  const marker = url.pathname.lastIndexOf(consoleApiMarker)
  return marker === -1 ? "" : url.pathname.slice(0, marker)
}

function consoleRpcCallURL(path: string): string {
  return `${consoleAppBase(path)}${consoleRpcCallPath}`
}

/** The media upload route under the application mount of a Console API path. */
export function consoleRpcUploadURL(path: string): string {
  return `${consoleAppBase(path)}${consoleRpcUploadPath}`
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

export class ConsoleNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Console network request failed.", { cause })
    this.name = "ConsoleNetworkError"
  }
}

export function isRetryableConsoleRequestError(error: unknown): boolean {
  if (!(error instanceof ConsoleRequestError)) return error instanceof ConsoleNetworkError
  return error.status === 408 || error.status === 429 || error.status === 500 || (error.status >= 502 && error.status <= 504)
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
  let response: Response
  try {
    response = await fetch(consoleRpcCallURL(path), {
    body: JSON.stringify({ method: call.method, input }),
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json", [consoleRpcHeader]: "1" },
    method: "POST",
    signal: options.signal,
    })
  }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    throw new ConsoleNetworkError(error)
  }
  const result = record(await response.json().catch(() => undefined))
  if (response.ok && result?.ok === true) return result.value
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  const status = typeof result?.status === "number" && result.status >= 400 ? result.status : response.ok ? 502 : response.status
  const failure: { code?: string, docs?: string, fix?: string, message?: string, failureCode?: string, details?: Record<string, unknown> } = {}
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Console responses are untrusted JSON.
  if (typeof result?.code === "string") failure.code = result.code
  if (typeof result?.docs === "string") failure.docs = result.docs
  if (typeof result?.fix === "string") failure.fix = result.fix
  if (typeof result?.message === "string") failure.message = result.message
  const details = record(result?.details)
  if (details) failure.details = details
  if (typeof result?.failureCode === "string") failure.failureCode = result.failureCode
  // Owner action responses use failureCode; ordinary diagnostics retain code/docs/fix.
  throw new ConsoleRequestError(status, failure)
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
