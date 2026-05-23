import { ofetch } from "ofetch"

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

export async function executeHttpRequest<TOutput = unknown>(
  definition: HttpRequestDefinition,
  options: HttpRequestExecutionOptions<TOutput> = {},
): Promise<HttpRequestResult<TOutput>> {
  const normalized = normalizeHttpRequest(definition)
  const responseType = options.responseType || "json"
  const response = await ofetch.raw(normalized.url.toString(), {
    body: normalized.body as any,
    headers: normalized.headers,
    method: normalized.method,
    query: normalized.query,
    responseType,
    retry: normalized.method === "GET" || normalized.method === "HEAD" ? 1 : 0,
    timeout: normalized.timeout,
  })
  const decoded = responseType === "text" && typeof response._data === "undefined" ? "" : response._data
  const data = options.schema ? await parseStandardSchema(options.schema, decoded, "HTTP response") : decoded
  return {
    data: data as TOutput,
    mediaType: response.headers.get("content-type") || undefined,
    status: response.status,
    summary: redactedHttpRequestSummary(normalized, responseType),
  }
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
