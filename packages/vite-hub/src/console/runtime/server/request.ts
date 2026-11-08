import { consoleDiagnostic, consoleStatusDiagnosticCode, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { getStandardContext } from "@vite-hub/runtime/h3"

import { isConsoleDevelopmentBuild } from "./development.ts"

import type { ViteHubContext } from "@vite-hub/runtime"

/**
 * A Console request event: any event with Standard Context properties, such as an H3 1 or H3 2 event in a ViteHub
 * app. Console code reads the request, the response, the host lifetime, and the Cloudflare bindings from
 * `event["~standard"]`. `context.params` holds the route parameters of H3 routes.
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
export function consoleRequestError(statusCode: number, statusMessage: string, code: ConsoleDiagnosticCode = consoleStatusDiagnosticCode(statusCode)): Error {
  return Object.assign(consoleDiagnostic(code, statusMessage), { statusCode, statusMessage })
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
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  }
  const response = getStandardContext(event).res
  for (const [name, value] of Object.entries(headers)) response.headers?.set(name, value)
}

/** The public URL of a request event. On H3 1, its Standard Context request keeps the mounted base that H3 strips. */
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
