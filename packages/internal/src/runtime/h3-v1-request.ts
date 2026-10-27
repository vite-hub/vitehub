/** The Node request fields that ViteHub reads from an H3 1 event, such as a Nuxt 4 server event. */
export interface H3V1NodeRequest extends AsyncIterable<unknown> {
  body?: unknown
  connection?: { encrypted?: boolean, remoteAddress?: string }
  headers: Record<string, string | string[] | undefined>
  method?: string
  originalUrl?: string
  rawBody?: unknown
  socket?: { encrypted?: boolean, remoteAddress?: string }
  url?: string
  [key: symbol]: unknown
}

/** The Node response fields that ViteHub writes through an H3 1 event. */
export interface H3V1NodeResponse {
  appendHeader?: (name: string, value: string | readonly string[]) => unknown
  getHeader(name: string): number | string | string[] | undefined
  getHeaders(): Record<string, number | string | string[] | undefined>
  removeHeader(name: string): void
  setHeader(name: string, value: number | string | readonly string[]): unknown
  statusCode: number
}

/** An H3 1 event. ViteHub builds a Web Request from `node.req`. */
export interface H3V1Event {
  _requestBody?: unknown
  node: { req: H3V1NodeRequest, res?: H3V1NodeResponse }
  web?: { request?: Request }
}

interface RequestInitWithDuplex extends RequestInit {
  duplex?: "half"
}

const payloadMethods = new Set(["DELETE", "PATCH", "POST", "PUT"])
const rawBodySymbol = Symbol.for("h3RawBody")
const nodeEventRequests = new WeakMap<object, Request>()

/** Return true for an event with an own `node.req` object, such as an H3 1 event. */
export function isH3V1Event(input: object): input is H3V1Event {
  if (!Object.hasOwn(input, "node")) return false
  const node: unknown = Reflect.get(input, "node")
  return isObjectLike(node) && isObjectLike(Reflect.get(node, "req"))
}

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function")
}

function isWebRequest(value: unknown): value is Request {
  if (!isObjectLike(value)) return false
  const headers = Reflect.get(value, "headers")
  return typeof Reflect.get(value, "url") === "string"
    && typeof Reflect.get(value, "method") === "string"
    && isObjectLike(headers)
    && typeof Reflect.get(headers, "get") === "function"
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function readNodeRequestHeaders(request: H3V1NodeRequest): Headers {
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
function readNodeRequestURL(request: H3V1NodeRequest): URL {
  const host = firstHeader(request.headers.host) || "localhost"
  const encrypted = request.socket?.encrypted || request.connection?.encrypted
  const protocol = firstHeader(request.headers["x-forwarded-proto"]) === "https" || encrypted ? "https" : "http"
  const path = (request.originalUrl || request.url || "/").replace(/^[/\\]+/, "/")
  return new URL(path, `${protocol}://${host}`)
}

function toBodyStream(value: unknown): ReadableStream<Uint8Array> | undefined {
  if (value instanceof ReadableStream) return value
  if (value instanceof Uint8Array) return new Blob([new Uint8Array(value)]).stream()
  if (typeof value === "string") return new Blob([value]).stream()
  if (value instanceof URLSearchParams) return new Blob([value.toString()]).stream()
  if (value instanceof Object && Object.getPrototypeOf(value) === Object.prototype) return new Blob([JSON.stringify(value)]).stream()
  return undefined
}

type ChunkReader = () => Promise<{ done?: boolean, value?: unknown }>

async function openNodeRequestBody(event: H3V1Event): Promise<ChunkReader | undefined> {
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
  if (!iterator) return undefined
  const chunks: Uint8Array[] = []
  const collected: Uint8Array[] = []
  let total = 0
  let ended = false
  let failed = false
  let failure: unknown
  let waiting: {
    resolve: (result: { done?: boolean, value?: unknown }) => void
    reject: (error: unknown) => void
  } | undefined
  const produce = async () => {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
        let bytes: Uint8Array
        if (typeof chunk === "string") bytes = new TextEncoder().encode(chunk)
        else if (chunk instanceof Uint8Array) bytes = chunk
        else throw new TypeError("[vitehub] Request body chunks must be strings or bytes.")
        collected.push(bytes)
        total += bytes.byteLength
        if (waiting) {
          waiting.resolve({ value: bytes })
          waiting = undefined
        }
        else {
          chunks.push(bytes)
        }
      }
      ended = true
      waiting?.resolve({ done: true })
      waiting = undefined
    }
    catch (error) {
      failed = true
      failure = error
      ended = true
      waiting?.reject(error)
      waiting = undefined
      throw error
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of collected) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  }
  let body: Promise<Uint8Array> | undefined
  const start = () => body ??= produce()
  // H3's body helpers consult this cache when available, allowing both readers.
  event._requestBody = { then: (resolve: (value: Uint8Array) => unknown, reject: (reason: unknown) => unknown) => start().then(resolve, reject) }
  return async () => {
    start()
    // The cached H3 body promise may not be consumed when only Standard Context
    // reads the request. Keep its rejection from becoming an unhandled rejection;
    // the pending reader still receives the original failure below.
    body?.catch(() => {})
    if (failed) throw failure
    if (chunks.length) return { value: chunks.shift() }
    if (ended) return { done: true }
    return new Promise((resolve, reject) => { waiting = { resolve, reject } })
  }
}

/** Read the body lazily, from a value a host already read or from the Node request stream. */
function readNodeRequestBody(event: H3V1Event): ReadableStream<Uint8Array> {
  let reader: Promise<ChunkReader | undefined> | undefined
  // A zero high-water mark keeps the Fetch Request constructor from pulling
  // the Node stream before a caller actually reads the request body. This lets
  // H3's readBody(event) consume the original stream first when both APIs are
  // used by the same route.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const read = await (reader ??= openNodeRequestBody(event))
      const chunk = await read?.()
      if (!chunk || chunk.done) {
        controller.close()
        return
      }
      const value = chunk.value
      if (typeof value === "string") controller.enqueue(new TextEncoder().encode(value))
      else if (value instanceof Uint8Array) controller.enqueue(value)
      else controller.error(new TypeError("[vitehub] Request body chunks must be strings or bytes."))
    },
  }, { highWaterMark: 0 })
}

/** Return one Web Request per H3 1 event. The body is read only when a caller reads the Request body. */
export function toH3V1Request(event: H3V1Event): Request {
  const cached = nodeEventRequests.get(event)
  if (cached) return cached
  if (isWebRequest(event.web?.request)) return event.web.request
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
 * Return the Web Request of a request, an H3 2 event with an own `req` request, or an H3 1 event such as Nuxt 4's.
 * H3 1 events have no `url`, so read the URL from the request this returns. Throws a `TypeError` for any other value.
 */
export function toEventRequest(event: object): Request {
  if (isWebRequest(event)) return event
  const req: unknown = Object.hasOwn(event, "req") ? Reflect.get(event, "req") : undefined
  if (isWebRequest(req)) return req
  if (isH3V1Event(event)) return toH3V1Request(event)
  throw new TypeError("[vitehub] Expected a Request, an H3 2 event, or an H3 1 event.")
}

function headerValues(value: number | string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [String(value)]
}

type HeadersMethods = "append" | "delete" | "entries" | "forEach" | "get" | "getSetCookie" | "has" | "keys" | "set" | "values" | typeof Symbol.iterator

/**
 * Return a `Headers` view of a Node response. Writes go to the Node response, so H3 1 sends them.
 * Reads return what the Node response holds now.
 */
export function createH3V1ResponseHeaders(response: H3V1NodeResponse): Headers {
  const snapshot = (): Headers => {
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.getHeaders())) {
      for (const item of headerValues(value)) headers.append(name, item)
    }
    return headers
  }
  const view = new Headers()
  const methods: Pick<Headers, HeadersMethods> = {
    append(name, value) {
      const current = headerValues(response.getHeader(name))
      response.setHeader(name, current.length ? [...current, value] : value)
    },
    delete(name) {
      response.removeHeader(name)
    },
    entries: () => snapshot().entries(),
    forEach(callback, thisArg) {
      snapshot().forEach((value, key) => callback.call(thisArg, value, key, view))
    },
    get: name => snapshot().get(name),
    getSetCookie: () => headerValues(response.getHeader("set-cookie")),
    has: name => response.getHeader(name) !== undefined,
    keys: () => snapshot().keys(),
    set(name, value) {
      response.setHeader(name, value)
    },
    values: () => snapshot().values(),
    [Symbol.iterator]: () => snapshot()[Symbol.iterator](),
  }
  return Object.assign(view, methods)
}
