import { consoleDiagnostic, consoleDiagnosticBody, consoleStatusDiagnosticCode, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { installRequestStandardContext } from "@vite-hub/runtime/internal/h3"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { isRuntimeResponse } from "@vite-hub/runtime/internal/runtime-type"

import { consoleHttpError, type ConsoleHttpError } from "./http-error.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ViteHubContext } from "@vite-hub/runtime"
import type { ConsoleRpcResult } from "../rpc.ts"

/**
 * A Console request event: any value with Standard Context properties, such as the Request of a Console route or an
 * H3 event in a ViteHub app. Console code reads the request, the response, the host lifetime, and the Cloudflare
 * bindings from `event["~standard"]`. `context.params` holds the parameters of a Console operation.
 */
export type ConsoleRequestEvent = ViteHubContext<{
  context?: {
    params?: Record<string, string | undefined>
  }
}>

/** A request event for a Console call that has only its Web Request, such as an operation run from MCP. */
export function consoleRequestEvent(request: Request): ConsoleRequestEvent {
  return { "~standard": { vendor: "vitehub-console", req: request, res: {} } }
}

export function setConsoleResponseStatus(event: ConsoleRequestEvent, status: number): void {
  getStandardContext(event).res.status = status
}

const maximumConsoleRequestBodyBytes = 64 * 1_024

/**
 * Reads a fetch request body as text and stops at `maximumBytes`, so an oversized body is not read in full.
 * Throws a `413` Console request error when the body is larger.
 */
export async function consoleRequestText(fetchBody: ReadableStream<Uint8Array>, maximumBytes: number = maximumConsoleRequestBodyBytes): Promise<string> {
  const reader = fetchBody.getReader()
  const decoder = new TextDecoder()
  let body = ""
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximumBytes) throw consoleRequestError(413, "Console request body exceeds the byte limit.")
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  }
  catch (error) {
    // Cleanup must not replace a size or read failure with a cancellation failure.
    await reader.cancel().catch(() => undefined)
    throw error
  }
  finally {
    reader.releaseLock()
  }
}

/** Read bounded JSON from the body of the Standard Context request. */
export async function consoleRequestJSON(event: ConsoleRequestEvent, maximumBytes: number = maximumConsoleRequestBodyBytes): Promise<unknown> {
  const body = getStandardContext(event).req.body
  if (!body) throw new SyntaxError("Request body is unavailable.")
  return JSON.parse(await consoleRequestText(body, maximumBytes))
}

/** A Console failure with an HTTP status. The code defaults to the Console code of the status. */
export function consoleRequestError(status: number, message: string, code: ConsoleDiagnosticCode = consoleStatusDiagnosticCode(status)): ConsoleHttpError {
  return consoleHttpError(status, consoleDiagnostic(code, message))
}

/** A failure of a Console route or operation, as JSON: the Console diagnostic fields, `ok: false`, and the status. */
export type ConsoleErrorResult = Extract<ConsoleRpcResult, { ok: false }>

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function errorStatus(error: unknown): number | undefined {
  const value = Object(error)
  const status: unknown = Reflect.get(value, "statusCode") ?? Reflect.get(value, "status")
  return Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? Number(status) : undefined
}

/** The JSON body of a failure. A failure without an HTTP status, such as a bug, is a `500`. */
export function consoleErrorResult(error: unknown): ConsoleErrorResult {
  const value = Object(error)
  const status = errorStatus(error) ?? 500
  const statusMessage = Reflect.get(value, "statusMessage")
  const message = typeof statusMessage === "string" ? statusMessage : error instanceof Error ? error.message : undefined
  // Owner action failures, such as CONTENT_INVALID, carry their code and JSON details. See consoleActionError().
  const ownerCode = text(Reflect.get(value, "consoleCode"))
  if (ownerCode) {
    const failure: ConsoleErrorResult = { code: ownerCode, message: message ?? "Console request failed.", ok: false, status }
    const details: unknown = Reflect.get(value, "consoleDetails")
    if (details instanceof Object && !Array.isArray(details)) Object.assign(failure, { details })
    return failure
  }
  // A failure site with its own diagnostic keeps its code and guidance. Others get the Console code of the status.
  const code = text(Reflect.get(value, "code"))
  if (!code) return { ...consoleDiagnosticBody(consoleStatusDiagnosticCode(status), message), ok: false, status }
  const result: ConsoleErrorResult = { code, message: message ?? "Console request failed.", ok: false, status }
  const fix = text(Reflect.get(value, "fix"))
  const docs = text(Reflect.get(value, "docs"))
  const details: unknown = Reflect.get(value, "details")
  if (fix) result.fix = fix
  if (docs) result.docs = docs
  // Server failures keep their details out of the response. Input and conflict failures name what to fix.
  if (status < 500 && details instanceof Object && !Array.isArray(details)) Object.assign(result, { details })
  return result
}

const consoleResponseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
}

/**
 * The JSON Response of a failure in a Console route, with the status of `consoleRequestError()`. A failure without an
 * HTTP status is a bug: the route logs it and answers `500` without its message.
 */
export function consoleErrorResponse(error: unknown): Response {
  let result: ConsoleErrorResult
  if (errorStatus(error) === undefined) {
    globalThis.console.error("[vitehub] A Console route failed.", error)
    result = { ...consoleDiagnosticBody("CONSOLE_REQUEST_FAILED"), ok: false, status: 500 }
  }
  else result = consoleErrorResult(error)
  return Response.json(result, { headers: consoleResponseHeaders, status: result.status })
}

/** A Console HTTP route: a Fetchable (https://fetchable.org). Nitro calls `fetch()` with the Request of each request. */
export interface ConsoleRoute {
  fetch(request: Request): Promise<Response>
}

/**
 * Serve a Console handler as a Fetchable route. The handler gets the Request as its request event: in a ViteHub app,
 * Nitro puts the Standard Context of the request on it. A Response that the handler returns is sent as it is. Any other
 * value is sent as JSON. A thrown failure becomes `consoleErrorResponse()`.
 */
export function consoleRoute(handler: (event: ConsoleRequestEvent) => unknown): ConsoleRoute {
  return {
    async fetch(request) {
      // Outside a ViteHub app, such as in a test, the Request gets a `fetch` Standard Context.
      installRequestStandardContext(request)
      try {
        // SAFETY: the runtime adapter installed this Request's Standard Context before the handler runs.
        const result = await handler(request as Request & ConsoleRequestEvent)
        return isRuntimeResponse(result) ? result : Response.json(result, { headers: consoleResponseHeaders })
      }
      catch (error) {
        return consoleErrorResponse(error)
      }
    },
  }
}

/** Tells if the Console runs on a development server. */
export function isConsoleDevelopmentRuntime(): boolean {
  return isConsoleDevelopmentBuild()
}

export function assertConsoleRequest(event: ConsoleRequestEvent, allowedMethods: readonly string[] = ["GET"]): void {
  setConsoleResponseHeaders(event)
  if (!allowedMethods.includes(getStandardContext(event).req.method)) throw consoleRequestError(405, "Method not allowed")
}

export function setConsoleResponseHeaders(event: ConsoleRequestEvent): void {
  const response = getStandardContext(event).res
  for (const [name, value] of Object.entries(consoleResponseHeaders)) response.headers?.set(name, value)
}

/** The public URL of a request event. */
export function consoleRequestURL(event: ConsoleRequestEvent): URL {
  return consolePublicURL(getStandardContext(event).req)
}

/** The URL of a request with the host and scheme that a proxy forwards. */
export function consolePublicURL(request: Request): URL {
  const header = (name: string) => request.headers.get(name)?.split(",")[0]?.trim()
  const url = new URL(request.url)
  const host = header("x-forwarded-host")
  const protocol = header("x-forwarded-proto")
  if (protocol === "http" || protocol === "https") url.protocol = `${protocol}:`
  if (host) {
    url.port = ""
    url.host = host
  }
  return url
}
