export type HttpRequestMethod = "GET" | "HEAD" | "POST"
export type HttpResponseType = "json" | "text"
export type InternalHttpResponseType = HttpResponseType | "arrayBuffer" | "blob"

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
  headers?: Record<string, string>
  method?: HttpRequestMethod
  query?: Record<string, unknown>
  timeout?: number
}

export interface HttpRequestDefinition extends HttpRequestOptions {
  url: string | URL
}

export interface NormalizedHttpRequest extends Omit<HttpRequestDefinition, "method" | "url"> {
  method: HttpRequestMethod
  url: URL
}

export interface HttpRequestExecutionOptions<TOutput = unknown> {
  responseType?: InternalHttpResponseType
  schema?: StandardSchemaV1<TOutput>
}

export interface HttpRequestResult<TOutput = unknown> {
  data: TOutput
  mediaType?: string
  status: number
  summary: RedactedHttpRequestSummary
}

export interface RedactedHttpRequestSummary {
  hasBody: boolean
  hasQuery: boolean
  headers: "redacted" | "none"
  method: HttpRequestMethod
  responseType: InternalHttpResponseType
  url: string
}

type FetchBody = Exclude<NonNullable<Parameters<typeof fetch>[1]>["body"], null | undefined>

export async function executeHttpRequest<TOutput = unknown>(
  definition: HttpRequestDefinition,
  options: HttpRequestExecutionOptions<TOutput> = {},
): Promise<HttpRequestResult<TOutput>> {
  const normalized = normalizeHttpRequest(definition)
  const responseType = options.responseType || "json"
  const response = await fetchWithRetry(normalized)
  const decoded = await decodeResponse(response, responseType)
  const data = options.schema ? await parseStandardSchema(options.schema, decoded, "HTTP response") : decoded
  return {
    data: data as TOutput,
    mediaType: response.headers.get("content-type") || undefined,
    status: response.status,
    summary: redactedHttpRequestSummary(normalized, responseType),
  }
}

async function fetchWithRetry(definition: NormalizedHttpRequest): Promise<Response> {
  const attempts = definition.method === "GET" || definition.method === "HEAD" ? 2 : 1
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchOnce(definition)
    }
    catch (error) {
      lastError = error
      if (attempt === attempts) break
    }
  }
  throw lastError
}

async function fetchOnce(definition: NormalizedHttpRequest): Promise<Response> {
  const headers = new Headers(definition.headers)
  const body = serializeRequestBody(definition.body, headers)
  const controller = definition.timeout ? new AbortController() : undefined
  const timeout = controller ? setTimeout(() => controller.abort(), definition.timeout) : undefined
  try {
    const response = await fetch(urlWithQuery(definition).toString(), {
      body,
      headers,
      method: definition.method,
      signal: controller?.signal,
    })
    if (!response.ok) {
      throw new Error(`[vitehub] HTTP request failed with status ${response.status}.`)
    }
    return response
  }
  finally {
    if (timeout) clearTimeout(timeout)
  }
}

function serializeRequestBody(body: unknown, headers: Headers): FetchBody | undefined {
  if (typeof body === "undefined") return undefined
  if (
    typeof body === "string"
    || body instanceof Uint8Array
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
    || typeof Blob !== "undefined" && body instanceof Blob
    || typeof FormData !== "undefined" && body instanceof FormData
    || typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams
    || typeof ReadableStream !== "undefined" && body instanceof ReadableStream
  ) {
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
    if (typeof value === "undefined") continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "undefined") url.searchParams.append(key, queryValue(item))
      }
      continue
    }
    url.searchParams.set(key, queryValue(value))
  }
  return url
}

function queryValue(value: unknown): string {
  if (value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return JSON.stringify(value)
}

async function decodeResponse(response: Response, responseType: InternalHttpResponseType): Promise<unknown> {
  if (responseType === "text") return await response.text()
  if (responseType === "arrayBuffer") return await response.arrayBuffer()
  if (responseType === "blob") return await response.blob()

  const text = await response.text()
  return text ? JSON.parse(text) : undefined
}

export function normalizeHttpRequest(definition: HttpRequestDefinition): NormalizedHttpRequest {
  const method = (definition.method || "GET").toUpperCase()
  if (method !== "GET" && method !== "HEAD" && method !== "POST") {
    throw new TypeError(`[vitehub] HTTP request method "${method}" is not supported. Use GET, HEAD, or POST.`)
  }
  return {
    ...definition,
    method,
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
    hasBody: typeof definition.body !== "undefined",
    hasQuery: Boolean(definition.query && Object.keys(definition.query).length),
    headers: definition.headers && Object.keys(definition.headers).length ? "redacted" : "none",
    method: definition.method,
    responseType,
    url: `${definition.url.origin}${definition.url.pathname}`,
  }
}

function formatIssues(issues: unknown): string {
  if (Array.isArray(issues)) {
    return issues.map(issue => typeof issue === "string" ? issue : JSON.stringify(issue)).join("; ")
  }
  return typeof issues === "string" ? issues : JSON.stringify(issues)
}
