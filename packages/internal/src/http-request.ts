import { Diagnostic } from "nostics"

import { abortable } from "./abort.ts"
import { internalErrorDiagnostics } from "./error-diagnostics.ts"

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
  /** Sends the request. Default: the global `fetch`. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>
  responseType?: InternalHttpResponseType
  /** Whether a rejected fetch can retry. Defaults to true; HTTP status retries are handled separately. */
  retryFetchError?: (error: unknown) => boolean
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

const blobPrototype = Blob.prototype
const blobSizeGetter = Object.getOwnPropertyDescriptor(blobPrototype, "size")?.get
const blobTypeGetter = Object.getOwnPropertyDescriptor(blobPrototype, "type")?.get
const blobSliceMethod = Object.getOwnPropertyDescriptor(blobPrototype, "slice")?.value as ((this: Blob, start?: number, end?: number, contentType?: string) => Blob) | undefined

function isBlobLike(value: unknown): value is Blob {
  if (value === null || typeof value !== "object" || !blobSizeGetter || !blobTypeGetter) return false
  try {
    Reflect.apply(blobSizeGetter, value, [])
    Reflect.apply(blobTypeGetter, value, [])
    return true
  } catch {
    return false
  }
}

function normalizeForeignBlob(value: Blob): Blob | undefined {
  if (!blobSizeGetter || !blobTypeGetter || !blobSliceMethod) return undefined
  try {
    const type = Reflect.apply(blobTypeGetter, value, [])
    Reflect.apply(blobSizeGetter, value, [])
    return Reflect.apply(blobSliceMethod, value, [0, undefined, type])
  } catch {
    return undefined
  }
}

const httpInterruptedMessage = "[vitehub] HTTP request was interrupted."

class HttpStatusError extends Diagnostic {
  constructor(readonly status: number) {
    super({ code: "INTERNAL_R0012", docs: "https://vitehub.dev/docs/reference/diagnostics", why: `[vitehub] HTTP request failed with status ${status}.` }, HttpStatusError)
    this.name = "HttpStatusError"
  }
}

type HttpAttempt =
  | { data: unknown, failure?: undefined, response: Response }
  | { failure: { cause: unknown, retryable: boolean } }

export async function executeHttpRequest<TOutput = unknown>(
  definition: HttpRequestDefinition,
  options: HttpRequestExecutionOptions<TOutput> = {},
): Promise<HttpRequestResult<TOutput>> {
  const normalized = normalizeHttpRequest(definition)
  const responseType = options.responseType || "json"
  const { data, response } = await fetchWithRetry(
    normalized,
    responseType,
    options.schema,
    options.fetch ?? ((input, init) => fetch(input, init)),
    options.retryFetchError ?? (() => true),
    options.signal,
  )
  return {
    // SAFETY: A supplied schema validates TOutput; without one, TOutput is the caller-selected decoded response contract.
    data: data as TOutput,
    mediaType: response.headers.get("content-type") || undefined,
    status: response.status,
    summary: redactedHttpRequestSummary(normalized, responseType),
  }
}

async function fetchWithRetry<TOutput>(
  definition: NormalizedHttpRequest,
  responseType: InternalHttpResponseType,
  schema: StandardSchemaV1<TOutput> | undefined,
  send: (input: string, init: RequestInit) => Promise<Response>,
  retryFetchError: (error: unknown) => boolean,
  signal: AbortSignal | undefined,
): Promise<{ data: unknown, response: Response }> {
  const attempts = definition.method === "GET" || definition.method === "HEAD" ? 2 : 1
  for (let attempt = 1; ; attempt++) {
    const result = await fetchOnce(definition, responseType, send, retryFetchError, signal)
    if (result.failure) {
      if (result.failure.retryable && attempt < attempts) continue
      throw result.failure.cause
    }
    if (!schema) return result
    const { response } = result
    return await abortable(signal, httpInterruptedMessage, async () => ({
      data: await parseStandardSchema(schema, result.data, "HTTP response"),
      response,
    }))
  }
}

/**
 * Sends one request and reads its body inside the request timeout.
 * A timeout or a caller abort stops the attempt at once, aborts the fetch, and cancels the body.
 */
async function fetchOnce(
  definition: NormalizedHttpRequest,
  responseType: InternalHttpResponseType,
  send: (input: string, init: RequestInit) => Promise<Response>,
  retryFetchError: (error: unknown) => boolean,
  signal: AbortSignal | undefined,
): Promise<HttpAttempt> {
  const controller = new AbortController()
  const timeout = new AbortController()
  const timedOut: HttpAttempt = {
    failure: { cause: new DOMException("This operation was aborted", "AbortError"), retryable: true },
  }
  const timer = setTimeout(() => timeout.abort(timedOut), definition.timeout)
  const stop = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  let response: Response | undefined
  try {
    return await abortable(stop, httpInterruptedMessage, async (): Promise<HttpAttempt> => {
      try {
        const headers = new Headers(definition.headers)
        applyCookies(headers, definition.cookies)
        response = await send(urlWithQuery(definition).toString(), {
          body: serializeRequestBody(definition.body, headers),
          headers,
          method: definition.method,
          signal: controller.signal,
        })
      }
      catch (cause) {
        return { failure: { cause, retryable: retryFetchError(cause) } }
      }
      if (!response.ok) {
        const cause = new HttpStatusError(response.status)
        cancelResponseBody(response)
        return { failure: { cause, retryable: cause.status === 408 || cause.status === 429 || cause.status >= 500 } }
      }
      try {
        return { data: await decodeResponse(response, responseType, definition.maxResponseBytes, controller.signal), response }
      }
      catch (cause) {
        return { failure: { cause, retryable: false } }
      }
    })
  }
  catch (error) {
    if (response) cancelResponseBody(response)
    if (error === timedOut) return timedOut
    throw error
  }
  finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {})
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
  if (isBlobLike(body) && !(body instanceof Blob)) {
    const normalized = normalizeForeignBlob(body)
    if (normalized) return normalized
  }
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

function responseSizeError(maxResponseBytes: number): Error {
  return internalErrorDiagnostics.INTERNAL_R0004({ message: `[vitehub] HTTP response exceeds the configured ${maxResponseBytes}-byte limit.` })
}

export function normalizeHttpRequest(definition: HttpRequestDefinition): NormalizedHttpRequest {
  const method = ((Object.hasOwn(definition, "method") ? definition.method : undefined) || "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw internalErrorDiagnostics.INTERNAL_R0005({ message: `[vitehub] HTTP request method "${method}" is not supported. Use GET, HEAD, or POST.` })
  }
  const timeout = Object.hasOwn(definition, "timeout") ? definition.timeout : undefined
  if (timeout !== undefined
    && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647)) {
    throw internalErrorDiagnostics.INTERNAL_R0006({ message: "[vitehub] HTTP request timeout must be a positive finite number no greater than 2147483647." })
  }
  const maxResponseBytes = Object.hasOwn(definition, "maxResponseBytes") ? definition.maxResponseBytes : undefined
  if (maxResponseBytes !== undefined
    && (!Number.isSafeInteger(maxResponseBytes)
      || maxResponseBytes <= 0
      || maxResponseBytes > maximumHttpMaxResponseBytes)) {
    throw internalErrorDiagnostics.INTERNAL_R0007({ message: `[vitehub] HTTP request maxResponseBytes must be a positive safe integer no greater than ${maximumHttpMaxResponseBytes}.` })
  }
  return {
    ...definition,
    maxResponseBytes: maxResponseBytes ?? defaultHttpMaxResponseBytes,
    method,
    timeout: timeout ?? defaultHttpRequestTimeout,
    url: definition.url instanceof URL ? definition.url : new URL(definition.url),
  }
}

export async function parseStandardSchema<TOutput>(schema: StandardSchemaV1<TOutput>, value: unknown, label: string): Promise<TOutput> {
  const result = await schema["~standard"].validate(value)
  if ("issues" in result && result.issues && result.issues.length > 0) {
    throw internalErrorDiagnostics.INTERNAL_R0008({ message: `[vitehub] Invalid ${label}: ${formatIssues(result.issues)}` })
  }
  if (!("value" in result)) {
    throw internalErrorDiagnostics.INTERNAL_R0009({ message: `[vitehub] Invalid ${label}: ${formatIssues(result.issues)}` })
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
