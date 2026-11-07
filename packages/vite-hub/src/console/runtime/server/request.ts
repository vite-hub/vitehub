import { consoleDiagnostic, consoleStatusDiagnosticCode, type ConsoleDiagnosticCode } from "../diagnostics.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"

interface ConsoleHeaders {
  get(name: string): string | null
}

export interface ConsoleRequestEvent {
  env?: Record<string, unknown>
  context?: {
    clientAddress?: string
    params?: Record<string, string | undefined>
  }
  req?: {
    body?: ReadableStream<Uint8Array> | null
    context?: { clientAddress?: string, [key: string]: unknown }
    ip?: string
    headers?: ConsoleHeaders
    json?: () => Promise<unknown>
    method?: string
    signal?: AbortSignal
    url?: string | URL
  }
  res?: {
    headers?: {
      set(name: string, value: string): void
    }
    status?: number
  }
  waitUntil?: (task: Promise<unknown>) => void
}

export function setConsoleResponseStatus(event: ConsoleRequestEvent, status: number): void {
  if (event.res) Object.assign(event.res, { status })
}

const maximumConsoleRequestBodyBytes = 64 * 1_024

function stringByteLength(value: string): number {
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return bytes
}

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

/** Read bounded JSON from a Fetch request body, or from an RPC request body that is already decoded. */
export async function consoleRequestJSON(event: ConsoleRequestEvent, maximumBytes: number = maximumConsoleRequestBodyBytes): Promise<unknown> {
  const fetchBody = event.req?.body
  if (fetchBody) return JSON.parse(await consoleRequestText(fetchBody, maximumBytes))
  if (!event.req?.json) throw new SyntaxError("Request body is unavailable.")
  const body = await event.req.json()
  if (stringByteLength(JSON.stringify(body) ?? "") > maximumBytes) throw consoleRequestError(413, "Console request body exceeds the byte limit.")
  return body
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
  const method = event.req?.method
  if (!method || !allowedMethods.includes(method)) throw consoleRequestError(405, "Method not allowed")
}

export function setConsoleResponseHeaders(event: ConsoleRequestEvent): void {
  const headers = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
  }
  for (const [name, value] of Object.entries(headers)) {
    event.res?.headers?.set(name, value)
  }
}

export function consoleRequestURL(event: ConsoleRequestEvent): URL {
  const value = event.req?.url || "/"
  const header = (name: string) => event.req?.headers?.get(name)?.split(",")[0]?.trim()
  const url = value instanceof URL ? new URL(value) : new URL(value, "http://localhost")
  const host = header("x-forwarded-host") ?? header("host")
  const protocol = header("x-forwarded-proto")
  if (protocol === "http" || protocol === "https") url.protocol = `${protocol}:`
  if (host) {
    url.port = ""
    url.host = host
  }
  return url
}
