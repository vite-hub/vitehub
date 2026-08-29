import { executeHttpRequest, parseStandardSchema } from "@vite-hub/internal/http-request"
import { posix } from "node:path"

import { normalizeSafeWorkspacePath } from "../core/path.ts"
import { markLiveWorkspaceSource } from "./live.ts"
import {
  markWorkspaceSourceRequestExecutor,
  markWorkspaceSourceRequestDescriptor,
} from "./request-metadata.ts"

import type {
  SourceContext,
  WorkspaceContent,
  WorkspaceSelectedScope,
  WorkspaceSource,
  WorkspaceSourceRequestDescriptor,
  WorkspaceSourceRequestExecutionInput,
  WorkspaceSourceRequestExecutionResult,
  MaybePromise,
  WorkspaceSourceResolutionContext,
} from "../core/types.ts"

export type FetchSourceMethod = "GET" | "HEAD" | "POST"
export type FetchSourceResponseType = "json" | "text"

export interface FetchSourceStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface FetchSourceStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface FetchSourceStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => FetchSourceStandardSchemaResultSuccess<T> | FetchSourceStandardSchemaResultFailure | Promise<FetchSourceStandardSchemaResultSuccess<T> | FetchSourceStandardSchemaResultFailure>
  }
}

export interface FetchSourceStandardJsonSchemaV1<T = unknown> extends FetchSourceStandardSchemaV1<T> {
  "~standard": FetchSourceStandardSchemaV1<T>["~standard"] & {
    jsonSchema: {
      input: (options?: { target?: string }) => Record<string, unknown>
    }
  }
}

type SourceRuntimeOptions = Pick<WorkspaceSource, "cache" | "materialize" | "probeKeys" | "sync">
type ExactOptions<TInput, TShape> = TInput & Record<Exclude<keyof TInput, keyof TShape>, never>

export interface FetchSourceCredentialOptions {
  cookies?: Record<string, string>
  headers?: Record<string, string>
  maxResponseBytes?: number
  timeout?: number
}

export type FetchSourceRequestOptions = FetchSourceCredentialOptions

export interface FetchSourceRequestCallbackContext {
  request: {
    body?: unknown
    hasBody: boolean
    hasQuery: boolean
    method: FetchSourceMethod
    query?: Record<string, unknown>
    url: string
  }
  selectedWorkspaceScope?: WorkspaceSelectedScope
  source: {
    key?: string
  }
  workspace: {
    name: string
  }
}

export type FetchSourceRequest =
  | FetchSourceCredentialOptions
  | ((context: FetchSourceRequestCallbackContext) => FetchSourceCredentialOptions | Promise<FetchSourceCredentialOptions>)

export interface FetchSourceOptions<TResponse = unknown, TOutput = TResponse> extends SourceRuntimeOptions {
  body?: unknown
  bodySchema?: FetchSourceStandardJsonSchemaV1
  cookies?: Record<string, string>
  headers?: Record<string, string>
  method?: FetchSourceMethod
  maxResponseBytes?: number
  query?: Record<string, unknown>
  querySchema?: FetchSourceStandardJsonSchemaV1<Record<string, unknown>>
  request?: FetchSourceRequest
  responseType?: FetchSourceResponseType
  timeout?: number
  transform?: (data: TResponse) => TOutput | Promise<TOutput>
  url: string | URL
  workspacePath?: string
}

export type FetchSourceResolver<TResponse = unknown, TOutput = TResponse> = (
  context: WorkspaceSourceResolutionContext,
) => MaybePromise<FetchSourceOptions<TResponse, TOutput> | false | null | undefined>

export type FetchSourceInput<TResponse = unknown, TOutput = TResponse> =
  | FetchSourceOptions<TResponse, TOutput>
  | FetchSourceResolver<TResponse, TOutput>

export function fetch<TResponse = unknown, TOutput = TResponse>(options: ExactOptions<FetchSourceOptions<TResponse, TOutput>, FetchSourceOptions<TResponse, TOutput>>): WorkspaceSource
export function fetch<const TOptions extends FetchSourceOptions<any, any>>(options: ExactOptions<TOptions, FetchSourceOptions<any, any>>): WorkspaceSource
export function fetch<TResponse = unknown, TOutput = TResponse>(resolve: FetchSourceResolver<TResponse, TOutput>): WorkspaceSource
export function fetch<TResponse = unknown, TOutput = TResponse>(input: FetchSourceInput<TResponse, TOutput>): WorkspaceSource {
  if (typeof input === "function") return resolvableFetchSource(input)
  return createFetchSource(input)
}

function createFetchSource<TResponse = unknown, TOutput = TResponse>(options: FetchSourceOptions<TResponse, TOutput>): WorkspaceSource {
  const responseType = normalizePublicResponseType(options.responseType || "json")
  const method = normalizeMethod(options.method)
  assertRequestShape(options, method)
  const workspacePath = normalizeFetchWorkspacePath(options)
  const mountPath = workspacePath ? posix.dirname(workspacePath) === "." ? "" : posix.dirname(workspacePath) : ""
  const key = workspacePath ? mountPath ? workspacePath.slice(mountPath.length + 1) : workspacePath : ""
  const descriptor = createFetchRequestDescriptor(options, method, responseType, workspacePath)

  const source = markWorkspaceSourceRequestExecutor(markWorkspaceSourceRequestDescriptor({
    cache: options.cache ?? false,
    fingerprint: {
      body: descriptor.request?.body,
      bodySchema: descriptor.request?.bodySchema,
      credentials: descriptor.credentials,
      method,
      path: workspacePath,
      query: descriptor.request?.query,
      querySchema: descriptor.request?.querySchema,
      responseType,
      url: String(options.url),
    },
    materialize: options.materialize || (options.sync ? "none" : "lazy"),
    mount: mountPath,
    name: "fetch",
    probeKeys: options.probeKeys || (key ? [key] : undefined),
    sync: options.sync,
    async getKeys() {
      if (!workspacePath) return []
      return [key]
    },
    async getItem(sourcePath, ctx) {
      if (!workspacePath) {
        throw new Error("[vitehub] Request-only fetch source does not expose a default Source-Backed Path.")
      }
      if (sourcePath !== key) {
        throw new Error(`[vitehub] Fetch source item does not exist: ${sourcePath}.`)
      }
      const request = await defaultFetchSourceRequest(options, method, ctx)
      const result = await executeHttpRequest({
        ...request,
        method,
        url: requestBaseUrl(options.url),
      }, {
        responseType,
        signal: ctx.abortSignal,
      })
      const transformed = options.transform ? await options.transform(result.data as TResponse) : result.data
      return {
        key,
        path: key,
        content: serializeFetchSourceContent(transformed, responseType),
        mediaType: result.mediaType ?? mediaTypeFor(responseType),
        metadata: {
          request: result.summary,
          status: result.status,
        },
      }
    },
    async getMeta(sourcePath) {
      if (!workspacePath) return undefined
      if (sourcePath !== key) return undefined
      return {
        mediaType: mediaTypeFor(responseType),
        request: {
          method,
          responseType,
          url: redactedUrl(options.url),
        },
      }
    },
  }, descriptor, { requestOnly: !workspacePath }), async (input, ctx) => {
    return await executeFetchSourceRequest(options, method, responseType, input, ctx)
  })

  return workspacePath ? markLiveWorkspaceSource(source, { [workspacePath]: key }) : source
}

function resolvableFetchSource<TResponse, TOutput>(resolve: FetchSourceResolver<TResponse, TOutput>): WorkspaceSource {
  return {
    fingerprint: {
      sourceResolution: "fetch",
    },
    materialize: "lazy",
    name: "fetch",
    async getKeys() {
      return []
    },
    async getItem(key) {
      throw new Error(`[vitehub] fetch() resolver did not resolve before reading ${JSON.stringify(key)}.`)
    },
    async getItems() {
      return []
    },
    async resolve(ctx) {
      const options = await resolve(ctx)
      return options ? createFetchSource(options) : false
    },
  }
}

function normalizePublicResponseType(responseType: string): FetchSourceResponseType {
  if (responseType !== "json" && responseType !== "text") {
    throw new TypeError(`[vitehub] fetch() responseType "${responseType}" is not supported in v1. Use json or text.`)
  }
  return responseType
}

function normalizeMethod(method: FetchSourceMethod | undefined): FetchSourceMethod {
  const normalized = (method || "GET").toUpperCase()
  if (normalized !== "GET" && normalized !== "HEAD" && normalized !== "POST") {
    throw new TypeError(`[vitehub] fetch() method "${normalized}" is not supported in v1. Use GET, HEAD, or POST.`)
  }
  return normalized
}

function normalizeFetchWorkspacePath(options: Pick<FetchSourceOptions, "workspacePath">): string | undefined {
  return options.workspacePath ? normalizeSafeWorkspacePath(options.workspacePath, { allowEmpty: false }) : undefined
}

function assertRequestShape(options: FetchSourceOptions<any, any>, method: FetchSourceMethod): void {
  if ((options.query !== undefined || urlHasQuery(options.url)) && options.querySchema !== undefined) {
    throw new TypeError("[vitehub] fetch() accepts either query or querySchema, not both.")
  }
  if (options.body !== undefined && options.bodySchema !== undefined) {
    throw new TypeError("[vitehub] fetch() accepts either body or bodySchema, not both.")
  }
  if ((method === "GET" || method === "HEAD") && (options.body !== undefined || options.bodySchema !== undefined)) {
    throw new TypeError(`[vitehub] fetch() ${method} requests cannot declare body or bodySchema.`)
  }
}

function urlHasQuery(url: string | URL): boolean {
  const parsed = url instanceof URL ? url : new URL(url)
  return Boolean(parsed.search)
}

function createFetchRequestDescriptor(
  options: FetchSourceOptions<any, any>,
  method: FetchSourceMethod,
  responseType: FetchSourceResponseType,
  workspacePath: string | undefined,
): WorkspaceSourceRequestDescriptor {
  const request: NonNullable<WorkspaceSourceRequestDescriptor["request"]> = {}
  const query = concreteQueryFromOptions(options)
  if (query && Object.keys(query).length) request.query = query
  if (options.querySchema) request.querySchema = schemaProjection(options.querySchema, "querySchema")
  if (options.body !== undefined) request.body = options.body
  if (options.bodySchema) request.bodySchema = schemaProjection(options.bodySchema, "bodySchema")

  return {
    cache: options.cache,
    credentials: descriptorCredentials(options),
    method,
    ...(Object.keys(request).length ? { request } : {}),
    responseType,
    url: redactedUrl(options.url),
    ...(workspacePath ? { workspacePath } : {}),
  }
}

function descriptorCredentials(options: Pick<FetchSourceOptions<any, any>, "cookies" | "headers" | "request">): WorkspaceSourceRequestDescriptor["credentials"] {
  if (typeof options.request === "function") {
    return { cookies: "dynamic", headers: "dynamic" }
  }
  const request = options.request
  const cookies = { ...options.cookies, ...request?.cookies }
  const headers = { ...options.headers, ...request?.headers }
  const credentials = {
    ...(Object.keys(cookies).length ? { cookies: Object.keys(cookies).sort() } : {}),
    ...(Object.keys(headers).length ? { headers: Object.keys(headers).sort() } : {}),
  }
  return Object.keys(credentials).length ? credentials : undefined
}

function schemaProjection(schema: FetchSourceStandardJsonSchemaV1, option: string): Record<string, unknown> {
  const project = schema["~standard"].jsonSchema?.input
  if (typeof project !== "function") {
    throw new TypeError(`[vitehub] fetch() ${option} must expose a Standard JSON Schema-compatible input projection.`)
  }
  return project({ target: "draft-2020-12" })
}

function concreteQueryFromOptions(options: Pick<FetchSourceOptions<any, any>, "query" | "url">): Record<string, unknown> | undefined {
  const parsed = options.url instanceof URL ? options.url : new URL(options.url)
  const query: Record<string, unknown> = {}
  for (const key of new Set([...parsed.searchParams.keys()])) {
    const values = parsed.searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0]
  }
  return Object.keys(query).length || options.query
    ? { ...query, ...options.query }
    : undefined
}

async function defaultFetchSourceRequest(
  options: FetchSourceOptions<any, any>,
  method: FetchSourceMethod,
  ctx: SourceContext,
  overrides: { body?: unknown, query?: Record<string, unknown> } = {},
) {
  const defaultQuery = options.query !== undefined || concreteQueryFromOptions(options)
    ? concreteQueryFromOptions(options)
    : options.querySchema ? await parseStandardSchema(options.querySchema, {}, "fetch() query default") : undefined
  const defaultBody = options.body !== undefined
    ? options.body
    : options.bodySchema ? await parseStandardSchema(options.bodySchema, {}, "fetch() body default") : undefined
  const query = overrides.query ?? defaultQuery
  const body = typeof overrides.body === "undefined" ? defaultBody : overrides.body
  const context = sourceRequestContext(options, method, { body, query }, ctx)
  const additions = typeof options.request === "function"
    ? await options.request(context)
    : options.request
  return {
    body,
    cookies: {
      ...options.cookies,
      ...additions?.cookies,
    },
    headers: {
      ...options.headers,
      ...additions?.headers,
    },
    method,
    maxResponseBytes: additions?.maxResponseBytes ?? options.maxResponseBytes,
    query,
    timeout: additions?.timeout ?? options.timeout,
  }
}

function sourceRequestContext(
  options: FetchSourceOptions<any, any>,
  method: FetchSourceMethod,
  request: { body?: unknown, query?: Record<string, unknown> },
  ctx: SourceContext,
): FetchSourceRequestCallbackContext {
  return {
    request: {
      body: request.body,
      hasBody: typeof request.body !== "undefined",
      hasQuery: Boolean(request.query && Object.keys(request.query).length),
      method,
      query: request.query,
      url: redactedUrl(options.url),
    },
    selectedWorkspaceScope: ctx.selectedWorkspaceScope,
    source: {
      key: ctx.source,
    },
    workspace: {
      name: ctx.workspace,
    },
  }
}

async function executeFetchSourceRequest(
  options: FetchSourceOptions<any, any>,
  method: FetchSourceMethod,
  responseType: FetchSourceResponseType,
  input: WorkspaceSourceRequestExecutionInput,
  ctx: SourceContext,
): Promise<WorkspaceSourceRequestExecutionResult> {
  if (input.method !== method) {
    throw new Error(`[vitehub] Source request method ${input.method} does not match declared method ${method}.`)
  }

  const query = await validateFetchRequestQuery(options, input.url)
  const body = await validateFetchRequestBody(options, input.body)
  const request = await defaultFetchSourceRequest(options, method, ctx, { body, query })
  const result = await executeHttpRequest({
    ...request,
    method,
    url: requestBaseUrl(options.url),
  }, {
    responseType,
    signal: ctx.abortSignal,
  })
  const transformed = options.transform ? await options.transform(result.data) : result.data

  return {
    content: serializeFetchSourceContent(transformed, responseType),
    mediaType: result.mediaType ?? mediaTypeFor(responseType),
    metadata: {
      request: result.summary,
      status: result.status,
    },
    status: result.status,
  }
}

async function validateFetchRequestQuery(
  options: FetchSourceOptions<any, any>,
  inputUrl: string,
): Promise<Record<string, unknown> | undefined> {
  const declared = requestBaseUrl(options.url)
  const requested = new URL(inputUrl)
  if (requested.origin !== declared.origin || requested.pathname !== declared.pathname) {
    throw new Error("[vitehub] Source request URL does not match the declared Source target.")
  }

  const requestedQuery = queryFromUrl(requested)
  if (options.querySchema) {
    return await parseStandardSchema(options.querySchema, requestedQuery ?? {}, "HTTP request query")
  }

  const expectedQuery = concreteQueryFromOptions(options)
  if (!jsonEqual(requestedQuery || {}, serializedQuery(expectedQuery) || {})) {
    throw new Error("[vitehub] Source request query does not match the declared Source request shape.")
  }
  return expectedQuery
}

async function validateFetchRequestBody(
  options: FetchSourceOptions<any, any>,
  body: unknown,
): Promise<unknown> {
  if (options.bodySchema) {
    return await parseStandardSchema(options.bodySchema, body ?? {}, "HTTP request body")
  }
  if (typeof options.body !== "undefined") {
    if (typeof body !== "undefined" && !jsonEqual(body, options.body)) {
      throw new Error("[vitehub] Source request body does not match the declared Source request shape.")
    }
    return options.body
  }
  if (typeof body !== "undefined") {
    throw new Error("[vitehub] Source request does not declare a body.")
  }
}

function requestBaseUrl(url: string | URL): URL {
  const parsed = url instanceof URL ? new URL(url) : new URL(url)
  parsed.search = ""
  parsed.hash = ""
  return parsed
}

function queryFromUrl(url: URL): Record<string, unknown> | undefined {
  const query: Record<string, unknown> = {}
  for (const key of new Set([...url.searchParams.keys()])) {
    const values = url.searchParams.getAll(key)
    query[key] = values.length > 1 ? values : values[0]
  }
  return Object.keys(query).length ? query : undefined
}

function serializedQuery(query: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!query) return undefined
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) params.append(key, String(item))
  }
  return queryFromUrl(new URL(`https://vitehub.local/?${params}`))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]))
}

function serializeFetchSourceContent(value: unknown, responseType: FetchSourceResponseType): WorkspaceContent {
  if (value instanceof Uint8Array) return value
  if (responseType === "json") return JSON.stringify(value, null, 2) ?? "null"
  if (typeof value === "string") return value
  return typeof value === "undefined" ? "" : String(value)
}

function mediaTypeFor(responseType: FetchSourceResponseType) {
  return responseType === "json" ? "application/json" : "text/plain"
}

function redactedUrl(url: string | URL) {
  const parsed = url instanceof URL ? url : new URL(url)
  return `${parsed.origin}${parsed.pathname}`
}
