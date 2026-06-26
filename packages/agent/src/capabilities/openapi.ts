import { executeHttpRequest } from "@vite-hub/internal/http-request"
import { defineCapability } from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentRuntimeConfig,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

type JsonSchema = Record<string, unknown>
type OpenAPIMethod = "GET" | "HEAD" | "POST"
type OpenAPIPathMethod = "get" | "head" | "post" | "put" | "patch" | "delete" | "options" | "trace"
type OpenAPIHeaders = Record<string, string>

interface OpenAPIDocument {
  components?: Record<string, unknown>
  paths?: Record<string, OpenAPIPathItem>
  servers?: Array<{ url?: string }>
}

interface OpenAPIPathItem extends Record<string, unknown> {
  parameters?: OpenAPIParameter[]
}

interface OpenAPIOperation {
  description?: string
  operationId?: string
  parameters?: OpenAPIParameter[]
  requestBody?: OpenAPIRequestBody | OpenAPIReference
  summary?: string
}

interface OpenAPIParameter {
  description?: string
  in?: string
  name?: string
  required?: boolean
  schema?: JsonSchema | OpenAPIReference
}

interface OpenAPIRequestBody {
  content?: Record<string, { schema?: JsonSchema | OpenAPIReference }>
}

interface OpenAPIReference {
  $ref: string
}

type OpenAPIContextValue<T, TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName> =
  T | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<T>)

interface OpenAPIOperationTool {
  bodySchema?: JsonSchema
  description: string
  method: OpenAPIMethod
  operationId: string
  path: string
  pathParameters: OpenAPIParameter[]
  queryParameters: OpenAPIParameter[]
}

interface OpenAPIToolInput {
  body?: unknown
  path?: Record<string, unknown>
  query?: Record<string, unknown>
}

export interface OpenAPIRequestContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends AgentCapabilityContext<TRuntimeConfig, Name> {
  input: OpenAPIToolInput
  operation: {
    id: string
    method: OpenAPIMethod
    path: string
  }
}

export interface OpenAPIResponseContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> extends OpenAPIRequestContext<TRuntimeConfig, Name> {
  response: {
    data: unknown
    mediaType?: string
    status: number
  }
}

export interface OpenAPIRequestDefaults {
  body?: unknown
  path?: Record<string, unknown>
  query?: Record<string, unknown>
}

export interface OpenAPIInputOptions {
  omit?: {
    body?: readonly string[]
    path?: readonly string[]
    query?: readonly string[]
  }
}

export interface OpenAPICapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  baseUrl?: OpenAPIContextValue<string | URL, TRuntimeConfig, Name>
  defaults?: OpenAPIRequestDefaults | ((context: OpenAPIRequestContext<TRuntimeConfig, Name>) => MaybePromise<OpenAPIRequestDefaults | undefined>)
  description?: string
  enabled?: boolean | ((context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<boolean>)
  headers?: OpenAPIHeaders | ((context: OpenAPIRequestContext<TRuntimeConfig, Name>) => MaybePromise<OpenAPIHeaders | undefined>)
  input?: OpenAPIInputOptions
  operations: {
    allow: readonly string[]
    exclude?: readonly string[]
  }
  responseType?: "json" | "text"
  spec: OpenAPIContextValue<string | URL | OpenAPIDocument, TRuntimeConfig, Name>
  specHeaders?: OpenAPIHeaders
  timeout?: number
  transformResponse?: (response: unknown, context: OpenAPIResponseContext<TRuntimeConfig, Name>) => MaybePromise<unknown>
}

const pathMethods = new Set<OpenAPIPathMethod>(["get", "head", "post", "put", "patch", "delete", "options", "trace"])
const supportedMethods = new Set(["GET", "HEAD", "POST"])

export function openapi<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
>(options: OpenAPICapabilityOptions<TRuntimeConfig, Name>): AgentCapabilityDefinition<TRuntimeConfig, Name> {
  assertOpenAPIOptions(options)
  let operations: Promise<{ baseUrl: URL, tools: OpenAPIOperationTool[] }> | undefined
  const dynamicOperations = typeof options.spec === "function" || typeof options.baseUrl === "function"

  return defineCapability({
    id: "openapi",
    metadata: {
      operations: [...options.operations.allow],
      spec: dynamicOperations
        ? "dynamic"
        : typeof options.spec === "object" && !(options.spec instanceof URL) ? "inline" : String(options.spec),
    },
    async tools(context) {
      if (!await isOpenAPIEnabled(options, context)) return undefined
      const resolved = dynamicOperations
        ? await loadOpenAPIOperations(options, context)
        : await (operations ||= loadOpenAPIOperations(options, context))
      return Object.fromEntries(resolved.tools.map(operation => [
        operation.operationId,
        createOpenAPITool(operation, resolved.baseUrl, options, context),
      ])) as AgentToolSet
    },
  })
}

async function isOpenAPIEnabled<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<boolean> {
  if (options.enabled === undefined) return true
  return typeof options.enabled === "function" ? await options.enabled(context) : options.enabled
}

function assertOpenAPIOptions(options: OpenAPICapabilityOptions): void {
  if (!options || typeof options !== "object") throw new TypeError("[vitehub] openapi() requires options.")
  if (!options.spec) throw new TypeError("[vitehub] openapi({ spec }) requires an OpenAPI document URL or object.")
  if (!Array.isArray(options.operations?.allow) || !options.operations.allow.length) {
    throw new TypeError("[vitehub] openapi({ operations: { allow } }) requires at least one allowed operationId.")
  }
}

async function loadOpenAPIOperations<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<{ baseUrl: URL, tools: OpenAPIOperationTool[] }> {
  const { document, specUrl } = await loadOpenAPIDocument(options, context)
  const baseUrl = resolveBaseUrl(await resolveContextValue(options.baseUrl, context), document, specUrl)
  const allowed = new Set(options.operations.allow)
  const allOperations = collectOperations(document, allowed)
  const excluded = new Set(options.operations.exclude || [])
  const selected = options.operations.allow
    .filter(operationId => !excluded.has(operationId))
    .map((operationId) => {
      const operation = allOperations.get(operationId)
      if (!operation) throw new Error(`[vitehub] openapi() operationId "${operationId}" was not found in the OpenAPI spec.`)
      return operation
    })
  if (!selected.length) throw new Error("[vitehub] openapi() operation filters removed every operation.")
  return { baseUrl, tools: selected }
}

async function loadOpenAPIDocument<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<{ document: OpenAPIDocument, specUrl?: URL }> {
  const spec = await resolveContextValue(options.spec, context)
  if (!spec) throw new TypeError("[vitehub] openapi({ spec }) requires an OpenAPI document URL or object.")
  if (typeof spec === "object" && !(spec instanceof URL)) {
    return { document: spec }
  }
  const specUrl = spec instanceof URL ? spec : new URL(spec)
  const result = await executeHttpRequest({
    headers: options.specHeaders,
    timeout: options.timeout,
    url: specUrl,
  })
  if (!result.data || typeof result.data !== "object") {
    throw new Error("[vitehub] openapi() spec must be a JSON OpenAPI document.")
  }
  return { document: result.data as OpenAPIDocument, specUrl }
}

async function resolveContextValue<T, TRuntimeConfig extends AgentRuntimeConfig, Name extends WorkspaceName>(
  value: OpenAPIContextValue<T, TRuntimeConfig, Name> | undefined,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): Promise<T | undefined> {
  return typeof value === "function"
    ? await (value as (context: AgentCapabilityContext<TRuntimeConfig, Name>) => MaybePromise<T>)(context)
    : value
}

function resolveBaseUrl(baseUrl: string | URL | undefined, document: OpenAPIDocument, specUrl: URL | undefined): URL {
  const value = baseUrl ?? document.servers?.[0]?.url ?? (specUrl ? specUrl.origin : undefined)
  if (!value) throw new Error("[vitehub] openapi() requires baseUrl when the spec does not declare servers[0].url.")
  return value instanceof URL ? new URL(value) : new URL(value, specUrl)
}

function collectOperations(document: OpenAPIDocument, allowed: Set<string>): Map<string, OpenAPIOperationTool> {
  const result = new Map<string, OpenAPIOperationTool>()
  for (const [path, pathItem] of Object.entries(document.paths || {})) {
    for (const [methodName, value] of Object.entries(pathItem)) {
      if (!pathMethods.has(methodName as OpenAPIPathMethod)) continue
      const operation = dereference(document, value) as OpenAPIOperation
      if (!operation?.operationId) continue
      assertToolName(operation.operationId)
      const method = methodName.toUpperCase()
      if (!supportedMethods.has(method) && allowed.has(operation.operationId)) {
        throw new Error(`[vitehub] openapi() operation "${operation.operationId}" uses ${method}; v1 supports GET, HEAD, and POST.`)
      }
      if (!supportedMethods.has(method)) continue
      if (result.has(operation.operationId)) {
        throw new Error(`[vitehub] Duplicate OpenAPI operationId "${operation.operationId}".`)
      }
      result.set(operation.operationId, {
        bodySchema: requestBodySchema(document, operation),
        description: operationDescription(operation),
        method: method as OpenAPIMethod,
        operationId: operation.operationId,
        path,
        pathParameters: operationParameters(document, pathItem, operation, "path"),
        queryParameters: operationParameters(document, pathItem, operation, "query"),
      })
    }
  }
  return result
}

function assertToolName(operationId: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(operationId)) {
    throw new TypeError(`[vitehub] OpenAPI operationId "${operationId}" must be usable as a tool name: letters, numbers, and underscores only.`)
  }
}

function operationDescription(operation: OpenAPIOperation): string {
  return [operation.summary, operation.description].filter(Boolean).join(" ") || `Call ${operation.operationId}.`
}

function operationParameters(document: OpenAPIDocument, pathItem: OpenAPIPathItem, operation: OpenAPIOperation, location: "path" | "query"): OpenAPIParameter[] {
  const params = new Map<string, OpenAPIParameter>()
  for (const raw of [...(pathItem.parameters || []), ...(operation.parameters || [])]) {
    const parameter = dereference(document, raw) as OpenAPIParameter
    if (parameter.in === location && parameter.name) params.set(parameter.name, {
      ...parameter,
      schema: dereference(document, parameter.schema || { type: "string" }) as JsonSchema,
    })
  }
  return [...params.values()]
}

function requestBodySchema(document: OpenAPIDocument, operation: OpenAPIOperation): JsonSchema | undefined {
  const body = dereference(document, operation.requestBody) as OpenAPIRequestBody | undefined
  const content = body?.content
  if (!content) return undefined
  const entry = content["application/json"] || Object.entries(content).find(([type]) => type.endsWith("+json"))?.[1]
  return entry?.schema ? dereference(document, entry.schema) as JsonSchema : undefined
}

function createOpenAPITool<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  operation: OpenAPIOperationTool,
  baseUrl: URL,
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): AgentToolDefinition {
  return defineInternalTool({
    description: [options.description, operation.description].filter(Boolean).join(" "),
    async execute(input) {
      const rawInput = normalizeRawToolInput(operation, input)
      const rawUrl = operationTemplateUrl(baseUrl, operation.path)
      const requestInput = normalizeToolInput(operation, mergeToolInput(
        await resolveDefaults(options, context, operation, rawInput, rawUrl),
        rawInput,
      ))
      const url = operationUrl(baseUrl, operation, requestInput.path)
      const headers = await resolveHeaders(options, context, operation, requestInput, url)
      const result = await executeHttpRequest({
        body: requestInput.body,
        headers,
        method: operation.method,
        query: requestInput.query,
        timeout: options.timeout,
        url,
      }, {
        responseType: options.responseType || "json",
      })
      return transformOpenAPIResponse(options, context, operation, requestInput, url, result)
    },
    inputSchema: operationInputSchema(operation, options.input),
    metadata: {
      openapi: {
        method: operation.method,
        operationId: operation.operationId,
        path: operation.path,
      },
    },
    name: operation.operationId,
  })
}

async function transformOpenAPIResponse<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
  operation: OpenAPIOperationTool,
  input: OpenAPIToolInput,
  url: URL,
  result: { data: unknown, mediaType?: string, status: number },
): Promise<unknown> {
  if (!options.transformResponse) return result.data
  return await options.transformResponse(result.data, {
    ...context,
    input,
    operation: {
      id: operation.operationId,
      method: operation.method,
      path: `${url.origin}${url.pathname}`,
    },
    response: {
      data: result.data,
      mediaType: result.mediaType,
      status: result.status,
    },
  })
}

function normalizeRawToolInput(operation: OpenAPIOperationTool, input: unknown): OpenAPIToolInput {
  const value = input == null ? {} : input
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`[vitehub] ${operation.operationId} input must be an object.`)
  }
  const record = value as Record<string, unknown>
  const allowedTopLevel = new Set(["path", "query", "body"])
  const extra = Object.keys(record).filter(key => !allowedTopLevel.has(key))
  if (extra.length && !supportsFlattenedBodyInput(operation, extra)) {
    throw new Error(`[vitehub] ${operation.operationId} does not support input option${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}.`)
  }
  if (record.path !== undefined && !isPlainRecord(record.path)) {
    throw new TypeError(`[vitehub] ${operation.operationId} path input must be an object.`)
  }
  if (record.query !== undefined && !isPlainRecord(record.query)) {
    throw new TypeError(`[vitehub] ${operation.operationId} query input must be an object.`)
  }
  if (!operation.bodySchema && record.body !== undefined) {
    throw new Error(`[vitehub] ${operation.operationId} does not declare a request body.`)
  }
  const flattenedBody = Object.fromEntries(extra.map(key => [key, record[key]]))
  if (extra.length && record.body !== undefined && !isPlainRecord(record.body)) {
    throw new TypeError(`[vitehub] ${operation.operationId} body input must be an object when mixed with top-level body fields.`)
  }
  return {
    ...(record.body !== undefined || extra.length ? { body: { ...flattenedBody, ...(record.body as Record<string, unknown> | undefined) } } : {}),
    ...(record.path ? { path: record.path as Record<string, unknown> } : {}),
    ...(record.query ? { query: record.query as Record<string, unknown> } : {}),
  }
}

function supportsFlattenedBodyInput(operation: OpenAPIOperationTool, keys: string[]): boolean {
  if (!operation.bodySchema) return false
  if (operation.bodySchema.additionalProperties === true) return true
  const properties = operation.bodySchema.properties
  if (!isPlainRecord(properties)) return false
  return keys.every(key => Object.hasOwn(properties, key))
}

function normalizeToolInput(operation: OpenAPIOperationTool, input: OpenAPIToolInput): OpenAPIToolInput {
  const path = normalizeParameterInput(operation.operationId, "path", operation.pathParameters, input.path)
  const query = normalizeParameterInput(operation.operationId, "query", operation.queryParameters, input.query)
  if (!operation.bodySchema && input.body !== undefined) {
    throw new Error(`[vitehub] ${operation.operationId} does not declare a request body.`)
  }
  return {
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(path ? { path } : {}),
    ...(query ? { query } : {}),
  }
}

async function resolveDefaults<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
  operation: OpenAPIOperationTool,
  input: OpenAPIToolInput,
  url: URL,
): Promise<OpenAPIRequestDefaults | undefined> {
  if (typeof options.defaults === "function") {
    return await options.defaults({
      ...context,
      input,
      operation: {
        id: operation.operationId,
        method: operation.method,
        path: `${url.origin}${url.pathname}`,
      },
    })
  }
  return options.defaults
}

function mergeToolInput(defaults: OpenAPIRequestDefaults | undefined, input: OpenAPIToolInput): OpenAPIToolInput {
  if (!defaults) return input
  return {
    body: mergeBody(defaults.body, input.body),
    path: { ...defaults.path, ...input.path },
    query: { ...defaults.query, ...input.query },
  }
}

function mergeBody(defaultBody: unknown, inputBody: unknown): unknown {
  if (inputBody === undefined) return defaultBody
  if (isPlainRecord(defaultBody) && isPlainRecord(inputBody)) return { ...defaultBody, ...inputBody }
  return inputBody
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeParameterInput(operationId: string, location: "path" | "query", parameters: OpenAPIParameter[], input: unknown): Record<string, unknown> | undefined {
  const required = parameters.filter(parameter => location === "path" || parameter.required).map(parameter => parameter.name as string)
  if (input === undefined) {
    if (required.length) throw new Error(`[vitehub] ${operationId} requires ${location} parameter${required.length === 1 ? "" : "s"}: ${required.join(", ")}.`)
    return undefined
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`[vitehub] ${operationId} ${location} input must be an object.`)
  }
  const allowed = new Set(parameters.map(parameter => parameter.name as string))
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => !allowed.has(key))
  if (extra.length) throw new Error(`[vitehub] ${operationId} does not support ${location} parameter${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}.`)
  for (const name of required) {
    if (value[name] === undefined) throw new Error(`[vitehub] ${operationId} requires ${location} parameter "${name}".`)
  }
  return value
}

function operationUrl(baseUrl: URL, operation: OpenAPIOperationTool, pathInput: Record<string, unknown> | undefined): URL {
  return operationTemplateUrl(baseUrl, operation.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathInput?.[name]
    if (value === undefined) throw new Error(`[vitehub] ${operation.operationId} requires path parameter "${name}".`)
    return encodeURIComponent(String(value))
  }))
}

function operationTemplateUrl(baseUrl: URL, path: string): URL {
  const url = new URL(baseUrl)
  const prefix = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname
  url.pathname = `${prefix}${path.startsWith("/") ? path : `/${path}`}`
  url.search = ""
  url.hash = ""
  return url
}

async function resolveHeaders<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
  operation: OpenAPIOperationTool,
  input: OpenAPIToolInput,
  url: URL,
): Promise<OpenAPIHeaders | undefined> {
  if (typeof options.headers === "function") {
    return await options.headers({
      ...context,
      input,
      operation: {
        id: operation.operationId,
        method: operation.method,
        path: `${url.origin}${url.pathname}`,
      },
    })
  }
  return options.headers
}

function operationInputSchema(operation: OpenAPIOperationTool, input?: OpenAPIInputOptions): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const pathParameters = visibleParameters(operation.pathParameters, input?.omit?.path)
  const queryParameters = visibleParameters(operation.queryParameters, input?.omit?.query)
  const bodySchema = visibleObjectSchema(operation.bodySchema, input?.omit?.body)
  if (pathParameters.length) {
    properties.path = parameterObjectSchema(pathParameters)
    if (pathParameters.some(parameter => parameter.required || parameter.in === "path")) required.push("path")
  }
  if (queryParameters.length) {
    properties.query = parameterObjectSchema(queryParameters)
  }
  if (bodySchema) {
    properties.body = bodySchema
    if (hasRequiredProperties(bodySchema)) required.push("body")
  }
  return {
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
    type: "object",
  }
}

function visibleParameters(parameters: OpenAPIParameter[], omit: readonly string[] | undefined): OpenAPIParameter[] {
  if (!omit?.length) return parameters
  const omitted = new Set(omit)
  return parameters.filter(parameter => !parameter.name || !omitted.has(parameter.name))
}

function visibleObjectSchema(schema: JsonSchema | undefined, omit: readonly string[] | undefined): JsonSchema | undefined {
  if (!schema || !omit?.length) return schema
  if (!isPlainRecord(schema.properties)) return schema
  const omitted = new Set(omit)
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !omitted.has(key)))
  const required = Array.isArray(schema.required)
    ? schema.required.filter(value => typeof value === "string" && !omitted.has(value))
    : []
  const { required: _required, ...rest } = schema
  return {
    ...rest,
    properties,
    ...(required.length ? { required } : {}),
  }
}

function hasRequiredProperties(schema: JsonSchema): boolean {
  return Array.isArray(schema.required) && schema.required.some(value => typeof value === "string")
}

function parameterObjectSchema(parameters: OpenAPIParameter[]): JsonSchema {
  return {
    additionalProperties: false,
    properties: Object.fromEntries(parameters.map(parameter => [parameter.name, {
      ...(parameter.schema as JsonSchema),
      ...(parameter.description ? { description: parameter.description } : {}),
    }])),
    required: parameters.filter(parameter => parameter.in === "path" || parameter.required).map(parameter => parameter.name),
    type: "object",
  }
}

function dereference(document: OpenAPIDocument, value: unknown, seen = new Set<string>()): unknown {
  if (!value || typeof value !== "object") return value
  if ("$ref" in value && typeof (value as OpenAPIReference).$ref === "string") {
    const ref = (value as OpenAPIReference).$ref
    if (!ref.startsWith("#/") || seen.has(ref)) return {}
    seen.add(ref)
    return dereference(document, ref.slice(2).split("/").reduce<unknown>((current, part) => {
      return current && typeof current === "object" ? (current as Record<string, unknown>)[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined
    }, document), seen)
  }
  if (Array.isArray(value)) return value.map(item => dereference(document, item, new Set(seen)))
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    dereference(document, item, new Set(seen)),
  ]))
}
