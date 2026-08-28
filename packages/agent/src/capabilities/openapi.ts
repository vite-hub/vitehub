import { executeHttpRequest } from "@vite-hub/internal/http-request"
import { defineCapability } from "../capability-runtime.ts"
import { defineInternalTool } from "./internal.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityCliContribution,
  AgentCapabilityCliStandardSchemaV1,
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

export type OpenAPIRequestContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = Omit<AgentCapabilityContext<TRuntimeConfig, Name>, "request"> & {
  input: OpenAPIToolInput
  operation: {
    id: string
    method: OpenAPIMethod
    path: string
  }
  request: OpenAPIRequestDraft
  runtimeRequest?: Request
}

export type OpenAPIResponseContext<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = OpenAPIRequestContext<TRuntimeConfig, Name> & {
  response: {
    data: unknown
    mediaType?: string
    status: number
  }
}

export interface OpenAPIRequestDraft {
  body?: unknown
  cookies: Record<string, string>
  headers: Headers
  maxResponseBytes?: number
  path: Record<string, unknown>
  query: Record<string, unknown>
  timeout?: number
}

export interface OpenAPIRequestPatch {
  body?: unknown
  cookies?: Record<string, string>
  headers?: Headers | OpenAPIHeaders
  maxResponseBytes?: number
  path?: Record<string, unknown>
  query?: Record<string, unknown>
  timeout?: number
}

export interface OpenAPIHookProvidedInput {
  body?: readonly string[]
  path?: readonly string[]
  query?: readonly string[]
}

export type OpenAPIRequestHook<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = (context: OpenAPIRequestContext<TRuntimeConfig, Name>) => MaybePromise<OpenAPIRequestPatch | void>

export interface OpenAPIRequestHookOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  handler: OpenAPIRequestHook<TRuntimeConfig, Name>
  provides?: OpenAPIHookProvidedInput
}

export interface OpenAPIHooks<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  request?: OpenAPIRequestHook<TRuntimeConfig, Name> | OpenAPIRequestHookOptions<TRuntimeConfig, Name>
}

export interface OpenAPICliOptions {
  description?: string
  name: string
}

export interface OpenAPICapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  cli?: OpenAPIContextValue<false | OpenAPICliOptions | undefined, TRuntimeConfig, Name>
  description?: string
  hooks?: OpenAPIHooks<TRuntimeConfig, Name>
  maxResponseBytes?: number
  operations: readonly string[]
  responseType?: "json" | "text"
  server?: OpenAPIContextValue<string | URL, TRuntimeConfig, Name>
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
  const dynamicOperations = typeof options.spec === "function" || typeof options.server === "function"
  const loadOperations = (context: AgentCapabilityContext<TRuntimeConfig, Name>) => {
    if (dynamicOperations) return loadOpenAPIOperations(options, context)
    if (operations) return operations
    const pending = loadOpenAPIOperations(options, context)
    operations = pending
    pending.catch(() => {
      if (operations === pending) operations = undefined
    })
    return pending
  }

  return defineCapability({
    id: "openapi",
    metadata: {
      operations: [...options.operations],
      spec: dynamicOperations
        ? "dynamic"
        : typeof options.spec === "object" && !(options.spec instanceof URL) ? "inline" : String(options.spec),
    },
    cli: options.cli
      ? async (context) => {
          const cli = await resolveContextValue(options.cli, context)
          if (!cli) return undefined
          const resolved = await loadOperations(context)
          return createOpenAPICli(cli, resolved.tools, resolved.baseUrl, options, context)
        }
      : undefined,
    async tools(context) {
      if (options.cli) return undefined
      const resolved = await loadOperations(context)
      return Object.fromEntries(resolved.tools.map(operation => [
        operation.operationId,
        createOpenAPITool(operation, resolved.baseUrl, options, context),
      ])) as AgentToolSet
    },
  })
}

function assertOpenAPIOptions(options: OpenAPICapabilityOptions): void {
  if (!options || typeof options !== "object") throw new TypeError("[vitehub] openapi() requires options.")
  if (!options.spec) throw new TypeError("[vitehub] openapi({ spec }) requires an OpenAPI document URL or object.")
  if (!Array.isArray(options.operations) || !options.operations.length) {
    throw new TypeError("[vitehub] openapi({ operations }) requires at least one allowed operationId.")
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
  const baseUrl = resolveBaseUrl(await resolveContextValue(options.server, context), document, specUrl)
  const allowed = new Set(options.operations)
  const allOperations = collectOperations(document, allowed)
  const selected = options.operations.map((operationId) => {
    const operation = allOperations.get(operationId)
    if (!operation) throw new Error(`[vitehub] openapi() operationId "${operationId}" was not found in the OpenAPI spec.`)
    return operation
  })
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
    maxResponseBytes: options.maxResponseBytes,
    timeout: options.timeout,
    url: specUrl,
  }, { signal: context.abortSignal })
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
  if (!value) throw new Error("[vitehub] openapi() requires server when the spec does not declare servers[0].url.")
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
    async execute(input, execution) {
      return executeOpenAPIOperation(operation, baseUrl, options, context, input, execution?.abortSignal)
    },
    inputSchema: operationInputSchema(operation, openAPIRequestProvidedInput(options)),
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

function createOpenAPICli<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  cli: OpenAPICliOptions,
  operations: OpenAPIOperationTool[],
  baseUrl: URL,
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
): AgentCapabilityCliContribution<TRuntimeConfig, Name> {
  const commands: AgentCapabilityCliContribution<TRuntimeConfig, Name>["commands"] = {}
  for (const operation of operations) {
    const name = operationCommandName(cli.name, operation.operationId)
    if (commands[name]) {
      throw new Error(`[vitehub] OpenAPI operationId "${operation.operationId}" generates duplicate ${cli.name} command "${name}".`)
    }
    const outputFormat = options.responseType === "text" ? "text" : "json"
    commands[name] = {
      description: operation.description,
      effects: [`http:${operation.method.toLowerCase()}`],
      examples: [`${cli.name} ${name}${outputFormat === "json" ? " --json" : ""}`],
      input: openAPICliInputSchema(operation, openAPIRequestProvidedInput(options)),
      output: { format: outputFormat },
      run: ({ input }) => executeOpenAPIOperation(operation, baseUrl, options, context, input),
    }
  }
  return {
    commands,
    description: cli.description || options.description || "Call allowed OpenAPI operations.",
    name: cli.name,
  }
}

function openAPICliInputSchema(operation: OpenAPIOperationTool, provided?: OpenAPIHookProvidedInput): AgentCapabilityCliStandardSchemaV1<OpenAPIToolInput> {
  const schema = operationInputSchema(operation, provided)
  return {
    "~standard": {
      validate(value) {
        try {
          const normalized = compactOpenAPIInput(applyOpenAPIProvidedInput(normalizeRawToolInput(operation, value), provided))
          const issues = validateJsonSchema(schema, normalized, "input")
          return issues.length ? { issues } : { value: normalized }
        }
        catch (error) {
          return { issues: [error instanceof Error ? error.message : String(error)] }
        }
      },
    },
  }
}

function compactOpenAPIInput(input: OpenAPIToolInput): OpenAPIToolInput {
  return {
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.path !== undefined && Object.keys(input.path).length ? { path: input.path } : {}),
    ...(input.query !== undefined && Object.keys(input.query).length ? { query: input.query } : {}),
  }
}

async function executeOpenAPIOperation<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  operation: OpenAPIOperationTool,
  baseUrl: URL,
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
  input: unknown,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  const rawInput = applyOpenAPIProvidedInput(normalizeRawToolInput(operation, input), openAPIRequestProvidedInput(options))
  const rawUrl = operationTemplateUrl(baseUrl, operation.path)
  const draft = createOpenAPIRequestDraft(rawInput, options.timeout, options.maxResponseBytes)
  await applyOpenAPIRequestHook(options, {
    ...context,
    input: rawInput,
    operation: {
      id: operation.operationId,
      method: operation.method,
      path: `${rawUrl.origin}${rawUrl.pathname}`,
    },
    request: draft,
    runtimeRequest: context.request,
  })
  assertValidOpenAPIRequest(operation, draft)
  const requestInput = normalizeToolInput(operation, draft)
  const url = operationUrl(baseUrl, operation, requestInput.path)
  const result = await executeHttpRequest({
    body: requestInput.body,
    cookies: Object.keys(draft.cookies).length ? draft.cookies : undefined,
    headers: headersToRecord(draft.headers),
    maxResponseBytes: draft.maxResponseBytes,
    method: operation.method,
    query: requestInput.query,
    timeout: draft.timeout,
    url,
  }, {
    responseType: options.responseType || "json",
    signal: abortSignal ?? context.abortSignal,
  })
  return transformOpenAPIResponse(options, context, operation, requestInput, draft, url, result)
}

function openAPIRequestOptions<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
): OpenAPIRequestHookOptions<TRuntimeConfig, Name> | undefined {
  if (!options.hooks?.request) return undefined
  return typeof options.hooks.request === "function" ? { handler: options.hooks.request } : options.hooks.request
}

function openAPIRequestProvidedInput<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
): OpenAPIHookProvidedInput | undefined {
  return openAPIRequestOptions(options)?.provides
}

function createOpenAPIRequestDraft(
  input: OpenAPIToolInput,
  timeout: number | undefined,
  maxResponseBytes: number | undefined,
): OpenAPIRequestDraft {
  return {
    ...(input.body !== undefined ? { body: input.body } : {}),
    cookies: {},
    headers: new Headers(),
    ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    path: { ...input.path },
    query: { ...input.query },
    ...(timeout !== undefined ? { timeout } : {}),
  }
}

async function applyOpenAPIRequestHook<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: OpenAPIRequestContext<TRuntimeConfig, Name>,
): Promise<void> {
  const hook = openAPIRequestOptions(options)?.handler
  if (!hook) return
  const patch = await hook(context)
  if (patch) applyOpenAPIRequestPatch(context.request, patch)
}

function applyOpenAPIRequestPatch(request: OpenAPIRequestDraft, patch: OpenAPIRequestPatch): void {
  if ("body" in patch) request.body = patch.body
  if (patch.path) request.path = { ...request.path, ...patch.path }
  if (patch.query) request.query = { ...request.query, ...patch.query }
  if (patch.cookies) request.cookies = { ...request.cookies, ...patch.cookies }
  if (patch.headers) {
    const headers = patch.headers instanceof Headers ? patch.headers : new Headers(patch.headers)
    headers.forEach((value, key) => request.headers.set(key, value))
  }
  if (patch.maxResponseBytes !== undefined) request.maxResponseBytes = patch.maxResponseBytes
  if (patch.timeout !== undefined) request.timeout = patch.timeout
}

function headersToRecord(headers: Headers): OpenAPIHeaders | undefined {
  const result: OpenAPIHeaders = {}
  headers.forEach((value, key) => {
    result[key] = value
  })
  return Object.keys(result).length ? result : undefined
}

function applyOpenAPIProvidedInput(input: OpenAPIToolInput, provided: OpenAPIHookProvidedInput | undefined): OpenAPIToolInput {
  if (!provided) return input
  return {
    ...input,
    body: omitInputFields(input.body, provided.body),
    path: omitInputFields(input.path, provided.path),
    query: omitInputFields(input.query, provided.query),
  }
}

function omitInputFields<T>(input: T, omitted: readonly string[] | undefined): T | undefined {
  if (!omitted?.length || input === undefined) return input
  if (!isPlainRecord(input)) return input
  const omittedFields = new Set(omitted)
  const visible = Object.fromEntries(Object.entries(input).filter(([key]) => !omittedFields.has(key)))
  return Object.keys(visible).length ? visible as T : undefined
}

function operationCommandName(cliName: string, operationId: string): string {
  const kebab = operationId.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase()
  const prefix = `${cliName.toLowerCase()}-`
  return kebab.startsWith(prefix) && kebab.length > prefix.length ? kebab.slice(prefix.length) : kebab
}

async function transformOpenAPIResponse<
  TRuntimeConfig extends AgentRuntimeConfig,
  Name extends WorkspaceName,
>(
  options: OpenAPICapabilityOptions<TRuntimeConfig, Name>,
  context: AgentCapabilityContext<TRuntimeConfig, Name>,
  operation: OpenAPIOperationTool,
  input: OpenAPIToolInput,
  request: OpenAPIRequestDraft,
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
    request,
    runtimeRequest: context.request,
    response: {
      data: result.data,
      mediaType: result.mediaType,
      status: result.status,
    },
  })
}

function assertValidOpenAPIRequest(operation: OpenAPIOperationTool, input: OpenAPIToolInput): void {
  const issues = validateJsonSchema(operationInputSchema(operation), compactOpenAPIInput(input), "request")
  if (issues.length) throw new Error(`[vitehub] ${operation.operationId} request is invalid: ${issues.join(", ")}`)
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
  const body = extra.length
    ? { ...flattenedBody, ...(record.body as Record<string, unknown> | undefined) }
    : record.body
  return {
    ...(record.body !== undefined || extra.length ? { body } : {}),
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

function operationInputSchema(operation: OpenAPIOperationTool, provided?: OpenAPIHookProvidedInput): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const pathParameters = visibleParameters(operation.pathParameters, provided?.path)
  const queryParameters = visibleParameters(operation.queryParameters, provided?.query)
  const bodySchema = visibleObjectSchema(operation.bodySchema, provided?.body)
  if (pathParameters.length) {
    properties.path = parameterObjectSchema(pathParameters)
    if (pathParameters.some(parameter => parameter.required || parameter.in === "path")) required.push("path")
  }
  if (queryParameters.length) {
    properties.query = parameterObjectSchema(queryParameters)
    if (queryParameters.some(parameter => parameter.required)) required.push("query")
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

function validateJsonSchema(schema: JsonSchema, value: unknown, label: string): string[] {
  const types = jsonSchemaTypes(schema)
  if (types.length && !types.some(type => jsonSchemaTypeMatches(type, value))) {
    return [`${label} must be ${types.join(" or ")}`]
  }
  if (value === null && types.includes("null")) return []
  const issues: string[] = []
  if (isJsonSchemaObject(schema)) {
    if (!isPlainRecord(value)) return [`${label} must be object`]
    const properties = isPlainRecord(schema.properties) ? schema.properties as Record<string, JsonSchema> : {}
    const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []
    for (const key of required) {
      if (value[key] === undefined) issues.push(`${label}.${key} is required`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) issues.push(`${label}.${key} is not supported`)
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      if (value[key] !== undefined && isPlainRecord(property)) {
        issues.push(...validateJsonSchema(property, value[key], `${label}.${key}`))
      }
    }
  }
  if (Array.isArray(value) && isPlainRecord(schema.items)) {
    value.forEach((item, index) => {
      issues.push(...validateJsonSchema(schema.items as JsonSchema, item, `${label}[${index}]`))
    })
  }
  return issues
}

function isJsonSchemaObject(schema: JsonSchema): boolean {
  return jsonSchemaTypes(schema).includes("object")
    || isPlainRecord(schema.properties)
    || Array.isArray(schema.required)
    || schema.additionalProperties === false
}

function jsonSchemaTypes(schema: JsonSchema): string[] {
  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === "string") : []
  return schema.nullable === true && types.length && !types.includes("null") ? [...types, "null"] : types
}

function jsonSchemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value)
    case "boolean":
      return typeof value === "boolean"
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "null":
      return value === null
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "object":
      return isPlainRecord(value)
    case "string":
      return typeof value === "string"
    default:
      return true
  }
}

function parameterObjectSchema(parameters: OpenAPIParameter[], includeRequired = true): JsonSchema {
  const required = includeRequired
    ? parameters.filter(parameter => parameter.in === "path" || parameter.required).map(parameter => parameter.name)
    : []
  return {
    additionalProperties: false,
    properties: Object.fromEntries(parameters.map(parameter => [parameter.name, {
      ...(parameter.schema as JsonSchema),
      ...(parameter.description ? { description: parameter.description } : {}),
    }])),
    ...(required.length ? { required } : {}),
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
