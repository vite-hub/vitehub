import type { AuthNodeRequest, AuthNodeRequestEvent, AuthRequest, AuthRequestInput } from "./types.ts"

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

const payloadMethods = new Set(["DELETE", "PATCH", "POST", "PUT"])
const rawBodySymbol = Symbol.for("h3RawBody")
const nodeEventRequests = new WeakMap<object, Request>()

function isNodeRequestEvent(input: AuthRequestInput): input is AuthNodeRequestEvent {
  if (!Object.hasOwn(input, "node")) return false
  const node: unknown = Reflect.get(input, "node")
  return node instanceof Object && Reflect.get(node, "req") instanceof Object
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function readNodeRequestHeaders(request: AuthNodeRequest): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    }
    else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}

/** Rebuild the public URL. H3 1 removes the app base path from `url` and keeps it in `originalUrl`. */
function readNodeRequestURL(request: AuthNodeRequest): URL {
  const host = firstHeader(request.headers.host) || "localhost"
  const encrypted = request.socket?.encrypted || request.connection?.encrypted
  const protocol = firstHeader(request.headers["x-forwarded-proto"]) === "https" || encrypted ? "https" : "http"
  const path = (request.originalUrl || request.url || "/").replace(/^[/\\]+/, "/")
  return new URL(path, `${protocol}://${host}`)
}

function toBodyStream(value: unknown): ReadableStream<Uint8Array> | undefined {
  if (value instanceof ReadableStream) return value
  if (value instanceof Uint8Array) return new Blob([value]).stream()
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Hosts store an already read request body as a string.
  if (typeof value === "string") return new Blob([value]).stream()
  if (value instanceof URLSearchParams) return new Blob([value.toString()]).stream()
  if (value instanceof Object && Object.getPrototypeOf(value) === Object.prototype) return new Blob([JSON.stringify(value)]).stream()
  return undefined
}

type ChunkReader = () => Promise<{ done?: boolean, value?: unknown }>

async function openNodeRequestBody(event: AuthNodeRequestEvent): Promise<ChunkReader | undefined> {
  const request = event.node.req
  const stored: unknown = event._requestBody ?? request[rawBodySymbol] ?? request.rawBody ?? request.body
  if (stored !== undefined && stored !== null) {
    const stream = toBodyStream(await stored)
    if (stream) {
      const reader = stream.getReader()
      return () => reader.read()
    }
  }
  const iterator = request[Symbol.asyncIterator]?.()
  return iterator ? () => iterator.next() : undefined
}

/** Read the body lazily, from a value a host already read or from the Node request stream. */
function readNodeRequestBody(event: AuthNodeRequestEvent): ReadableStream<Uint8Array> {
  let reader: Promise<ChunkReader | undefined> | undefined
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = await (reader ??= openNodeRequestBody(event))
      const chunk = await read?.()
      if (!chunk || chunk.done) {
        controller.close()
        return
      }
      const value = chunk.value
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Node streams yield strings when an encoding is set.
      if (typeof value === "string") controller.enqueue(new TextEncoder().encode(value))
      else if (value instanceof Uint8Array) controller.enqueue(value)
      else controller.error(new TypeError("[vitehub] Auth request body chunks must be strings or bytes."))
    },
  })
}

function toNodeEventRequest(event: AuthNodeRequestEvent): Request {
  const cached = nodeEventRequests.get(event)
  if (cached) return cached
  if (event.web?.request instanceof Request) return event.web.request
  const request = event.node.req
  const method = (request.method || "GET").toUpperCase()
  const init: RequestInitWithDuplex = { headers: readNodeRequestHeaders(request), method }
  if (payloadMethods.has(method)) {
    init.body = readNodeRequestBody(event)
    init.duplex = "half"
  }
  const webRequest = new Request(readNodeRequestURL(request), init)
  nodeEventRequests.set(event, webRequest)
  return webRequest
}

/**
 * Return the request of a Web Request, an event with an own `req` request such as H3 2,
 * or an event with an own `node.req` Node request such as H3 1 in Nuxt 4.
 */
export function unwrapAuthRequest(input: AuthRequestInput): AuthRequest {
  if (Object.hasOwn(input, "req")) {
    // SAFETY: AuthRequestInput is a request or an own-property host wrapper; inherited req values must not replace the request.
    return (input as { req: AuthRequest }).req
  }
  if (isNodeRequestEvent(input)) return toNodeEventRequest(input)
  // SAFETY: The remaining AuthRequestInput branch is the request itself.
  return input as AuthRequest
}
