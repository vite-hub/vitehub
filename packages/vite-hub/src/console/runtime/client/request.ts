import { connectDevframe } from "devframe/client"

import { consoleRpcMethods } from "../rpc"

import type { DevframeRpcClient } from "devframe/client"
import type { ConsoleRpcInput, ConsoleRpcMethod } from "../rpc"

const consoleApiMarker = "/api/_vitehub/console/"
const consoleDevframePath = "/_vitehub/rpc/"
const clients = new Map<string, Promise<DevframeRpcClient>>()

export class ConsoleRequestError extends Error {
  readonly status: number

  constructor(status: number, message = `Console request failed with status ${status}.`) {
    super(message)
    this.name = "ConsoleRequestError"
    this.status = status
  }
}

function consoleDevframeBase(path: string): string {
  const url = new URL(path, "http://vitehub.local")
  const marker = url.pathname.indexOf(consoleApiMarker)
  const appBase = marker === -1 ? "" : url.pathname.slice(0, marker)
  return `${appBase}${consoleDevframePath}`
}

function consoleRpcCall(path: string): { agent?: string; id?: string; method: ConsoleRpcMethod } {
  const url = new URL(path, "http://vitehub.local")
  const marker = url.pathname.indexOf(consoleApiMarker)
  const operation = marker === -1 ? "" : url.pathname.slice(marker + consoleApiMarker.length)
  const agentInvocationMatch = /^agents\/([^/]+)\/invocations$/.exec(operation)
  if (agentInvocationMatch) {
    return {
      agent: agentInvocationMatch[1]!,
      method: consoleRpcMethods.agentInvocations,
    }
  }
  if (operation.startsWith("invocations/")) {
    return {
      id: decodeURIComponent(operation.slice("invocations/".length)),
      method: consoleRpcMethods.invocation,
    }
  }
  const key = operation === "invocation-capabilities" ? "invocationCapabilities" : operation
  const method = Object.entries(consoleRpcMethods).find(([name]) => name === key)?.[1]
  if (!method) throw new ConsoleRequestError(404, "Console operation not found.")
  return { method }
}

function consoleDevframeClient(baseURL: string): Promise<DevframeRpcClient> {
  let client = clients.get(baseURL)
  if (!client) {
    client = connectDevframe({
      baseURL,
      otpParam: false,
      simpleAuth: false,
      transport: "sse",
    }).catch((error) => {
      clients.delete(baseURL)
      throw error
    })
    clients.set(baseURL, client)
  }
  return client
}

function abortable<T>(value: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return value
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    value
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined)
  })
}

export function isRetryableConsoleRequestError(error: unknown): boolean {
  return !(error instanceof ConsoleRequestError) || error.status === 408 || error.status === 429 || error.status >= 500
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
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue
    query[key] = Array.isArray(value) ? value.map(String) : String(value)
  }
  const call = consoleRpcCall(path)
  const input: ConsoleRpcInput = { method: options.method ?? "GET", query }
  if (call.agent !== undefined) input.agent = call.agent
  if (call.id !== undefined) input.id = call.id
  if (options.body !== undefined) input.body = options.body
  const client = await abortable(consoleDevframeClient(consoleDevframeBase(path)), options.signal)
  const response = await abortable(client.call(call.method, input), options.signal)
  if (!response.ok) throw new ConsoleRequestError(response.status, response.message)
  return response.value
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
  const error = new Error(message ?? `Console request failed with error code ${code}.`)
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
