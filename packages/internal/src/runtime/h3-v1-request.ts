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

/**
 * Return true for an event with an own `node.req` object, such as an H3 1 event. An event whose `req` is already a Web
 * Request is an H3 2 event, even with `node.req`: Nuxt 5 adds that legacy bridge to its H3 2 events. Rebuilding the
 * request from the bridge would lose its body and its identity.
 */
export function isH3V1Event(input: object): input is H3V1Event {
  if (isWebRequest(Reflect.get(input, "req"))) return false
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
  if (value instanceof Uint8Array) {
    // Not a Blob: the DOM types refuse a view whose buffer may be shared.
    return new ReadableStream({
      start(controller) {
        controller.enqueue(value)
        controller.close()
      },
    })
  }
  if (typeof value === "string") return new Blob([value]).stream()
  if (value instanceof URLSearchParams) return new Blob([value.toString()]).stream()
  if (value instanceof Object && Object.getPrototypeOf(value) === Object.prototype) return new Blob([JSON.stringify(value)]).stream()
  return undefined
}

/** One reader of a request body. `cancel()` stops the source, so the host reads no more of the body. */
interface BodySource {
  read(): Promise<{ done?: boolean, value?: unknown }>
  cancel(reason: unknown): Promise<void>
}

function toBodyBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === "string") return new TextEncoder().encode(chunk)
  if (chunk instanceof Uint8Array) return chunk
  throw new TypeError("[vitehub] Request body chunks must be strings or bytes.")
}

/**
 * Read the Node request stream only as fast as a reader asks. The Web Request reads chunk by chunk, and H3's body
 * helpers read `event._requestBody`, which reads to the end. Both get the same bytes, so a route can use both. A
 * cancelled Web body closes the Node stream and drops the bytes it kept, so an oversized body is not read in full.
 */
function openNodeRequestStream(event: H3V1Event, iterator: AsyncIterator<unknown>): BodySource {
  let chunks: Uint8Array[] = []
  let ended = false
  let cancelled = false
  let failure: { error: unknown } | undefined
  let pending: Promise<void> | undefined
  const readChunk = async () => {
    try {
      const result = await iterator.next()
      if (result.done) ended = true
      else if (!cancelled) chunks.push(toBodyBytes(result.value))
    }
    catch (error) {
      failure = { error }
      ended = true
    }
  }
  // Readers that wait at the same time share one read of the Node stream.
  const pull = () => pending ??= readChunk().finally(() => { pending = undefined })
  let whole: Promise<Uint8Array> | undefined
  const readWhole = async () => {
    while (!ended && !cancelled) await pull()
    if (failure) throw failure.error
    if (cancelled) throw new TypeError("[vitehub] The request body was cancelled.")
    const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  }
  // H3's body helpers consult this cache when available, allowing both readers.
  event._requestBody = { then: (resolve: (value: Uint8Array) => unknown, reject: (reason: unknown) => unknown) => (whole ??= readWhole()).then(resolve, reject) }
  let index = 0
  return {
    async read() {
      while (true) {
        if (cancelled) return { done: true }
        if (index < chunks.length) return { value: chunks[index++] }
        if (failure) throw failure.error
        if (ended) return { done: true }
        await pull()
      }
    },
    async cancel(reason) {
      if (cancelled) return
      cancelled = true
      chunks = []
      // Node's stream iterator destroys the stream on return(), so the host stops reading the body.
      if (!ended) await iterator.return?.(reason)
    },
  }
}

async function openNodeRequestBody(event: H3V1Event): Promise<BodySource | undefined> {
  const request = event.node.req
  const stored: unknown = event._requestBody ?? request[rawBodySymbol] ?? request.rawBody ?? request.body
  if (stored !== undefined && stored !== null) {
    const stream = toBodyStream(await stored)
    if (stream) {
      const reader = stream.getReader()
      return { read: () => reader.read(), cancel: reason => reader.cancel(reason) }
    }
  }
  const iterator = request[Symbol.asyncIterator]?.()
  return iterator ? openNodeRequestStream(event, iterator) : undefined
}

/** Read the body lazily, from a value a host already read or from the Node request stream. */
function readNodeRequestBody(event: H3V1Event): ReadableStream<Uint8Array> {
  let source: Promise<BodySource | undefined> | undefined
  // A zero high-water mark keeps the Fetch Request constructor from pulling
  // the Node stream before a caller actually reads the request body. This lets
  // H3's readBody(event) consume the original stream first when both APIs are
  // used by the same route.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await (await (source ??= openNodeRequestBody(event)))?.read()
      if (!chunk || chunk.done) {
        controller.close()
        return
      }
      const value = chunk.value
      if (typeof value === "string") controller.enqueue(new TextEncoder().encode(value))
      else if (value instanceof Uint8Array) controller.enqueue(value)
      else controller.error(new TypeError("[vitehub] Request body chunks must be strings or bytes."))
    },
    async cancel(reason) {
      // A body that nobody read keeps its Node stream for H3's own body helpers.
      await (await source)?.cancel(reason)
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
