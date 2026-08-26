import { Data, Effect } from "effect"

import { createEffectBoundary, EffectBoundaryFailure } from "./effect.ts"

export type HttpRequestMethod = "GET" | "HEAD" | "POST"
export type HttpResponseType = "json" | "text"
export type InternalHttpResponseType = HttpResponseType | "arrayBuffer" | "blob"

export const defaultHttpRequestTimeout = 30_000
export const defaultHttpMaxResponseBytes = 5 * 1024 * 1024
export const maximumHttpMaxResponseBytes = 25 * 1024 * 1024

export interface StandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface StandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface StandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => StandardSchemaResultSuccess<T> | StandardSchemaResultFailure | Promise<StandardSchemaResultSuccess<T> | StandardSchemaResultFailure>
  }
}

export interface HttpRequestOptions {
  body?: unknown
  cookies?: Record<string, string>
  headers?: Record<string, string>
  method?: HttpRequestMethod
  maxResponseBytes?: number
  query?: Record<string, unknown>
  timeout?: number
}

export interface HttpRequestDefinition extends HttpRequestOptions {
  url: string | URL
}

export interface NormalizedHttpRequest extends Omit<HttpRequestDefinition, "maxResponseBytes" | "method" | "timeout" | "url"> {
  maxResponseBytes: number
  method: HttpRequestMethod
  timeout: number
  url: URL
}

export interface HttpRequestExecutionOptions<TOutput = unknown> {
  responseType?: InternalHttpResponseType
  schema?: StandardSchemaV1<TOutput>
  signal?: AbortSignal
}

export interface HttpRequestResult<TOutput = unknown> {
  data: TOutput
  mediaType?: string
  status: number
  summary: RedactedHttpRequestSummary
}

export interface RedactedHttpRequestSummary {
  cookies: "redacted" | "none"
  hasBody: boolean
  hasQuery: boolean
  headers: "redacted" | "none"
  method: HttpRequestMethod
  responseType: InternalHttpResponseType
  url: string
}

type FetchBody = Exclude<NonNullable<Parameters<typeof fetch>[1]>["body"], null | undefined>

function primitiveRuntimeTag(value: unknown): string | undefined {
  return value !== null && value !== undefined && Object(value) !== value
    ? Object.prototype.toString.call(value)
    : undefined
}

const httpEffectBoundary = createEffectBoundary({
  aggregateMessage: "[vitehub] HTTP request failed.",
  interruptionMessage: "[vitehub] HTTP request was interrupted.",
})

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`[vitehub] HTTP request failed with status ${status}.`)
  }
}

class HttpAttemptFailure extends Data.TaggedError("HttpAttemptFailure")<{
  readonly cause: unknown
  readonly retryable: boolean
}> {}

export async function executeHttpRequest<TOutput = unknown>(
  definition: HttpRequestDefinition,
  options: HttpRequestExecutionOptions<TOutput> = {},
): Promise<HttpRequestResult<TOutput>> {
  const normalized = normalizeHttpRequest(definition)
  const responseType = options.responseType || "json"
  const { data, response } = await httpEffectBoundary.run(
    fetchWithRetry(normalized, responseType, options.schema),
    { signal: options.signal },
  )
  return {
    // SAFETY: A supplied schema validates TOutput; without one, TOutput is the caller-selected decoded response contract.
    data: data as TOutput,
    mediaType: response.headers.get("content-type") || undefined,
    status: response.status,
    summary: redactedHttpRequestSummary(normalized, responseType),
  }
}

function fetchWithRetry<TOutput>(
  definition: NormalizedHttpRequest,
  responseType: InternalHttpResponseType,
  schema: StandardSchemaV1<TOutput> | undefined,
): Effect.Effect<{ data: unknown, response: Response }, EffectBoundaryFailure> {
  const attempts = definition.method === "GET" || definition.method === "HEAD" ? 2 : 1
  const attempt = fetchOnce(definition, responseType, schema)
  const timed = Effect.timeoutOrElse(attempt, {
    duration: definition.timeout,
    orElse: () => Effect.fail(new HttpAttemptFailure({
      cause: new DOMException("This operation was aborted", "AbortError"),
      retryable: true,
    })),
  })
  return Effect.retry(timed, {
    times: attempts - 1,
    while: error => error.retryable,
  }).pipe(
    Effect.mapError(error => new EffectBoundaryFailure({ cause: error.cause })),
  )
}

function fetchOnce<TOutput>(
  definition: NormalizedHttpRequest,
  responseType: InternalHttpResponseType,
  schema: StandardSchemaV1<TOutput> | undefined,
): Effect.Effect<{ data: unknown, response: Response }, HttpAttemptFailure> {
  return Effect.acquireUseRelease(
    Effect.sync(() => new AbortController()),
    controller => Effect.tryPromise({
      catch: cause => new HttpAttemptFailure({ cause, retryable: true }),
      try: () => {
        const headers = new Headers(definition.headers)
        applyCookies(headers, definition.cookies)
        return fetch(urlWithQuery(definition).toString(), {
          body: serializeRequestBody(definition.body, headers),
          headers,
          method: definition.method,
          signal: controller.signal,
        })
      },
    }).pipe(
      Effect.flatMap((response) => {
        if (response.ok) return decodeHttpResponse(response, responseType, schema, definition.maxResponseBytes, controller.signal)
        const cause = new HttpStatusError(response.status)
        return cancelResponseBody(response).pipe(
          Effect.andThen(Effect.fail(new HttpAttemptFailure({
            cause,
            retryable: cause.status === 408 || cause.status === 429 || cause.status >= 500,
          }))),
        )
      }),
    ),
    controller => Effect.sync(() => controller.abort()),
  )
}

function cancelResponseBody(response: Response): Effect.Effect<void> {
  const body = response.body
  return body
    ? Effect.sync(() => {
        void body.cancel().catch(() => {})
      })
    : Effect.void
}

function decodeHttpResponse<TOutput>(
  response: Response,
  responseType: InternalHttpResponseType,
  schema: StandardSchemaV1<TOutput> | undefined,
  maxResponseBytes: number,
  signal: AbortSignal,
): Effect.Effect<{ data: unknown, response: Response }, HttpAttemptFailure> {
  return Effect.tryPromise({
    catch: cause => new HttpAttemptFailure({ cause, retryable: false }),
    try: async () => {
      const decoded = await decodeResponse(response, responseType, maxResponseBytes, signal)
      const data = schema ? await parseStandardSchema(schema, decoded, "HTTP response") : decoded
      return { data, response }
    },
  }).pipe(
    Effect.onInterrupt(() => cancelResponseBody(response)),
  )
}

function applyCookies(headers: Headers, cookies: Record<string, string> | undefined): void {
  if (!cookies || !Object.keys(cookies).length) return
  const value = Object.entries(cookies)
    .map(([name, cookieValue]) => `${name}=${cookieValue}`)
    .join("; ")
  const existing = headers.get("cookie")
  headers.set("cookie", existing ? `${existing}; ${value}` : value)
}

function serializeRequestBody(body: unknown, headers: Headers): FetchBody | undefined {
  if (body === undefined) return undefined
  if (
    primitiveRuntimeTag(body) === "[object String]"
    || body instanceof Uint8Array
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof URLSearchParams
    || body instanceof ReadableStream
  ) {
    // SAFETY: Each branch above is a Fetch BodyInit representation; the DOM types disagree only on ArrayBuffer backing width.
    return body as FetchBody
  }
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return JSON.stringify(body)
}

function urlWithQuery(definition: NormalizedHttpRequest): URL {
  const url = new URL(definition.url)
  if (!definition.query) return url
  for (const [key, value] of Object.entries(definition.query)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) url.searchParams.append(key, queryValue(item))
      }
      continue
    }
    url.searchParams.set(key, queryValue(value))
  }
  return url
}

function queryValue(value: unknown): string {
  if (value === null) return ""
  const tag = primitiveRuntimeTag(value)
  if (tag === "[object String]" || tag === "[object Number]" || tag === "[object Boolean]" || tag === "[object BigInt]") return String(value)
  return JSON.stringify(value)
}

async function decodeResponse(
  response: Response,
  responseType: InternalHttpResponseType,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await readResponseBytes(response, maxResponseBytes, signal)
  if (responseType === "arrayBuffer") return bytes.slice().buffer
  if (responseType === "blob") {
    return new Blob([bytes.slice()], { type: response.headers.get("content-type") || "" })
  }

  const text = new TextDecoder().decode(bytes)
  if (responseType === "text") return text
  return text ? JSON.parse(text) : undefined
}

async function readResponseBytes(response: Response, maxResponseBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length")?.trim()
  if (response.body
    && !response.headers.has("content-encoding")
    && declaredLength
    && /^\d+$/.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxResponseBytes)) {
    const error = responseSizeError(maxResponseBytes)
    void response.body.cancel(error).catch(() => {})
    throw error
  }

  const body = response.body
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener("abort", cancelReader, { once: true })
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxResponseBytes) {
        const error = responseSizeError(maxResponseBytes)
        void reader.cancel(error).catch(() => {})
        throw error
      }
      chunks.push(chunk.value)
    }
  }
  finally {
    signal.removeEventListener("abort", cancelReader)
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function responseSizeError(maxResponseBytes: number): RangeError {
  return new RangeError(`[vitehub] HTTP response exceeds the configured ${maxResponseBytes}-byte limit.`)
}

export function normalizeHttpRequest(definition: HttpRequestDefinition): NormalizedHttpRequest {
  const method = (definition.method || "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw new TypeError(`[vitehub] HTTP request method "${method}" is not supported. Use GET, HEAD, or POST.`)
  }
  if (definition.timeout !== undefined
    && (!Number.isFinite(definition.timeout) || definition.timeout <= 0 || definition.timeout > 2_147_483_647)) {
    throw new TypeError("[vitehub] HTTP request timeout must be a positive finite number no greater than 2147483647.")
  }
  if (definition.maxResponseBytes !== undefined
    && (!Number.isSafeInteger(definition.maxResponseBytes)
      || definition.maxResponseBytes <= 0
      || definition.maxResponseBytes > maximumHttpMaxResponseBytes)) {
    throw new TypeError(`[vitehub] HTTP request maxResponseBytes must be a positive safe integer no greater than ${maximumHttpMaxResponseBytes}.`)
  }
  return {
    ...definition,
    maxResponseBytes: definition.maxResponseBytes ?? defaultHttpMaxResponseBytes,
    method,
    timeout: definition.timeout ?? defaultHttpRequestTimeout,
    url: definition.url instanceof URL ? definition.url : new URL(definition.url),
  }
}

export async function parseStandardSchema<TOutput>(schema: StandardSchemaV1<TOutput>, value: unknown, label: string): Promise<TOutput> {
  const result = await schema["~standard"].validate(value)
  if ("issues" in result && result.issues && result.issues.length > 0) {
    throw new Error(`[vitehub] Invalid ${label}: ${formatIssues(result.issues)}`)
  }
  if (!("value" in result)) {
    throw new Error(`[vitehub] Invalid ${label}: ${formatIssues(result.issues)}`)
  }
  return result.value
}

export function redactedHttpRequestSummary(
  definition: NormalizedHttpRequest,
  responseType: InternalHttpResponseType,
): RedactedHttpRequestSummary {
  return {
    cookies: definition.cookies && Object.keys(definition.cookies).length ? "redacted" : "none",
    hasBody: definition.body !== undefined,
    hasQuery: Boolean(definition.query && Object.keys(definition.query).length),
    headers: definition.headers && Object.keys(definition.headers).length ? "redacted" : "none",
    method: definition.method,
    responseType,
    url: `${definition.url.origin}${definition.url.pathname}`,
  }
}

function formatIssues(issues: unknown): string {
  if (Array.isArray(issues)) {
    return issues.map(issue => primitiveRuntimeTag(issue) === "[object String]" ? String(issue) : JSON.stringify(issue)).join("; ")
  }
  return primitiveRuntimeTag(issues) === "[object String]" ? String(issues) : JSON.stringify(issues)
}
