import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
interface ConsoleHeaders {
  get(name: string): string | null
}

export interface ConsoleRequestEvent {
  context?: {
    clientAddress?: string
    params?: Record<string, string | undefined>
  }
  headers?: ConsoleHeaders
  method?: string
  node?: {
    req?: {
      method?: string
      socket?: { remoteAddress?: string }
      url?: string
      [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>
    }
    res?: {
      setHeader(name: string, value: string): void
    }
  }
  req?: {
    body?: ReadableStream<Uint8Array> | null
    context?: { clientAddress?: string }
    ip?: string
    headers?: ConsoleHeaders
    json?: () => Promise<unknown>
    method?: string
    url?: string | URL
  }
  res?: {
    headers?: {
      set(name: string, value: string): void
    }
  }
  waitUntil?: (task: Promise<unknown>) => void
}

export function setConsoleResponseStatus(event: ConsoleRequestEvent, status: number): void {
  if (event.res) Object.assign(event.res, { status })
  if (event.node?.res) Object.assign(event.node.res, { statusCode: status })
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

export async function consoleRequestJSON(event: ConsoleRequestEvent): Promise<unknown> {
  const fetchBody = event.req?.body
  if (fetchBody) {
    const reader = fetchBody.getReader()
    const decoder = new TextDecoder()
    let body = ""
    let bytes = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maximumConsoleRequestBodyBytes) {
        await reader.cancel()
        throw consoleRequestError(413, "Console request body exceeds the byte limit.")
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body)
  }
  if (event.req?.json) return event.req.json()
  const request = event.node?.req
  if (!request?.[Symbol.asyncIterator]) throw new SyntaxError("Request body is unavailable.")
  const decoder = new TextDecoder()
  let body = ""
  let bytes = 0
  // SAFETY: The iterator presence check above proves this H3 v1 request can be consumed as an async byte stream.
  for await (const chunk of request as AsyncIterable<Uint8Array | string>) {
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 v1 request streams may yield decoded strings or byte chunks.
    const chunkBytes = typeof chunk === "string" ? stringByteLength(chunk) : chunk.byteLength
    bytes += chunkBytes
    if (bytes > maximumConsoleRequestBodyBytes) {
      throw consoleRequestError(413, "Console request body exceeds the byte limit.")
    }
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- H3 v1 request streams may yield decoded strings or byte chunks.
    body += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
  }
  body += decoder.decode()
  return JSON.parse(body)
}

function consoleRequestError(statusCode: number, statusMessage: string): Error {
  return Object.assign(viteHubErrorDiagnostics.VITE_HUB_R0069({ message: statusMessage }), { statusCode, statusMessage })
}

export function assertConsoleRequest(event: ConsoleRequestEvent, allowedMethods: readonly string[] = ["GET"]): void {
  setConsoleResponseHeaders(event)
  const method = event.method ?? event.req?.method ?? event.node?.req?.method
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
    event.node?.res?.setHeader(name, value)
  }
}

export function consoleRequestURL(event: ConsoleRequestEvent): URL {
  const value = event.req?.url ?? event.node?.req?.url ?? "/"
  return value instanceof URL ? value : new URL(value, "http://localhost")
}
