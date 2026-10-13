import { createEffectBoundary } from "@vite-hub/internal/effect"
import { AnnotationsSchema, BlobResourceContentsSchema, ResourceContentsSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"

import { sourceError } from "../core/errors.ts"
import { normalizeSafeSourcePath } from "../core/path.ts"
import { matchesAny } from "./path.ts"

import type { FileSource, SourceCacheOptions, SourceContent, SourceContext } from "../core/types.ts"
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { sourceErrorDiagnostics } from "../error-diagnostics.ts"

export interface McpResourcesRequestOptions {
  maxTotalTimeout?: number
  onprogress?: (progress: { message?: string, progress: number, total?: number }) => void
  onresumptiontoken?: (token: string) => void
  relatedRequestId?: number | string
  relatedTask?: { taskId: string }
  resetTimeoutOnProgress?: boolean
  resumptionToken?: string
  signal?: AbortSignal
  task?: { pollInterval?: number, ttl?: number }
  timeout?: number
}

export interface McpResourceDescriptor {
  _meta?: Record<string, unknown>
  annotations?: {
    audience?: Array<"assistant" | "user">
    lastModified?: string
    priority?: number
  }
  description?: string
  icons?: Array<{
    mimeType?: string
    sizes?: string[]
    src: string
    theme?: "dark" | "light"
  }>
  mimeType?: string
  name: string
  size?: number
  title?: string
  uri: string
}

export type McpResourceContent =
  | { _meta?: Record<string, unknown>, blob: string, mimeType?: string, uri: string }
  | { _meta?: Record<string, unknown>, mimeType?: string, text: string, uri: string }

type McpResourcesMessage =
  | { id: number | string, jsonrpc: "2.0", method: string, params?: { [key: string]: unknown, _meta?: Record<string, unknown> } }
  | { id?: never, jsonrpc: "2.0", method: string, params?: { [key: string]: unknown, _meta?: Record<string, unknown> } }
  | { id: number | string, jsonrpc: "2.0", method?: never, result: { [key: string]: unknown, _meta?: Record<string, unknown> } }
  | { error: { code: number, data?: unknown, message: string }, id: number | string, jsonrpc: "2.0", method?: never }

export interface McpResourcesTransport {
  close(): Promise<void>
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: McpResourcesMessage) => void
  send(message: McpResourcesMessage): Promise<void>
  start(): Promise<void>
}

export interface McpResourcesClient {
  close?: () => void | Promise<void>
  getServerVersion?: () => { name: string, version: string } | undefined
  listResources: (
    params?: { cursor?: string },
    options?: McpResourcesRequestOptions,
  ) => Promise<{ nextCursor?: string, resources: McpResourceDescriptor[] }>
  readResource: (
    params: { uri: string },
    options?: McpResourcesRequestOptions,
  ) => Promise<{ contents: McpResourceContent[] }>
  serverInfo?: unknown
}

export type McpResourcesTransportConfig =
  | McpResourcesTransport
  | {
    authProvider?: unknown
    fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
    reconnectionOptions?: {
      initialReconnectionDelay: number
      maxReconnectionDelay: number
      maxRetries: number
      reconnectionDelayGrowFactor: number
    }
    requestInit?: RequestInit
    sessionId?: string
    type?: "http"
    url: string | URL
  }
  | {
    authProvider?: unknown
    eventSourceInit?: unknown
    fetch?: (url: string | URL, init?: RequestInit) => Promise<Response>
    requestInit?: RequestInit
    type: "sse"
    url: string | URL
  }

export interface McpResourcesClientConfig {
  transport: McpResourcesTransportConfig
}

export type McpResourcesServer =
  | McpResourcesClient
  | McpResourcesClientConfig
  | ((ctx: SourceContext) => McpResourcesClient | McpResourcesClientConfig | Promise<McpResourcesClient | McpResourcesClientConfig>)

export interface McpResourcesSourceOptions<TKey extends string = string> {
  cache?: false | SourceCacheOptions
  ignore?: string | readonly string[]
  include?: string | string[]
  path?: (resource: McpResourceDescriptor) => TKey | string | undefined
  request?: McpResourcesRequestOptions
  server: McpResourcesServer
}

interface ResourceEntry<TKey extends string = string> {
  contents?: McpResourceContent[]
  key: TKey
  resource: McpResourceDescriptor
}

const mcpEffectBoundary = createEffectBoundary({
  aggregateMessage: "[vitehub] MCP Resource Source operation failed for multiple reasons.",
  interruptionMessage: "[vitehub] MCP Resource Source operation was interrupted.",
})

function isMcpResourcesClient(value: unknown): value is McpResourcesClient {
  return typeof value === "object"
    && value !== null
    && hasDeclaredFunction(value, "listResources")
    && hasDeclaredFunction(value, "readResource")
}

function isMcpResourcesClientConfig(value: unknown): value is McpResourcesClientConfig {
  return typeof value === "object"
    && value !== null
    && hasDeclaredProperty(value, "transport")
    && (isMcpTransport(Reflect.get(value, "transport")) || isMcpTransportConfig(Reflect.get(value, "transport")))
}

function isMcpTransport(value: unknown): value is McpResourcesTransport {
  return typeof value === "object"
    && value !== null
    && hasDeclaredFunction(value, "close")
    && hasDeclaredFunction(value, "send")
    && hasDeclaredFunction(value, "start")
}

function isMcpTransportConfig(value: unknown): value is Exclude<McpResourcesTransportConfig, McpResourcesTransport> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Transport configs cross the MCP configuration boundary and require object validation.
  return typeof value === "object"
    && value !== null
    && Object.hasOwn(value, "url")
    && (!Reflect.has(value, "type") || (Object.hasOwn(value, "type") && (Reflect.get(value, "type") === "http" || Reflect.get(value, "type") === "sse")))
}

function hasDeclaredProperty(value: unknown, key: PropertyKey): value is object {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Capability lookup requires an object before inspecting its own fields and prototypes.
  if (typeof value !== "object" || value === null) return false
  if (Object.hasOwn(value, key)) return true
  let prototype = Object.getPrototypeOf(value)
  while (prototype && prototype !== Object.prototype) {
    if (Object.hasOwn(prototype, key)) {
      const constructor = Object.hasOwn(prototype, "constructor") ? prototype.constructor : undefined
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Only class constructors can declare inherited MCP capabilities; plain functions can forge prototype links.
      return typeof constructor === "function"
        && constructor.prototype === prototype
        && /^class\b/.test(Function.prototype.toString.call(constructor))
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}

function hasDeclaredFunction(value: unknown, key: PropertyKey): boolean {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- MCP methods must be callable before they cross the client or transport boundary.
  return hasDeclaredProperty(value, key) && typeof Reflect.get(value, key) === "function"
}

async function createMcpTransport(config: McpResourcesTransportConfig): Promise<Transport> {
  // SAFETY: isMcpTransport verifies the SDK transport methods before this private boundary.
  if (isMcpTransport(config)) return config as Transport
  const { type = "http", url, ...options } = config
  if (type === "sse") {
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js")
    return new SSEClientTransport(new URL(url), options as SSEClientTransportOptions)
  }
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  return new StreamableHTTPClientTransport(new URL(url), options as StreamableHTTPClientTransportOptions)
}

async function createMcpClient(config: McpResourcesClientConfig) {
  const [{ Client }, transport] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    createMcpTransport(config.transport),
  ])
  return {
    client: new Client({ name: "vitehub-source", version: "0.0.1" }),
    transport,
  }
}

async function resolveMcpServer(server: McpResourcesServer, ctx: SourceContext) {
  const resolved = typeof server === "function" ? await server(ctx) : server
  if (isMcpResourcesClient(resolved) || isMcpResourcesClientConfig(resolved)) return resolved
  throw sourceErrorDiagnostics.SOURCE_R0021({ message: "[vitehub] mcpResources({ server }) must resolve to an MCP client or MCP client config." })
}

function withRequestSignal(request: McpResourcesRequestOptions | undefined, signal: AbortSignal) {
  return {
    ...request,
    signal: request?.signal && request.signal !== signal
      ? AbortSignal.any([request.signal, signal])
      : signal,
  }
}

async function withMcpClient<T>(
  server: McpResourcesServer,
  ctx: SourceContext,
  request: McpResourcesRequestOptions | undefined,
  callback: (client: McpResourcesClient, request: McpResourcesRequestOptions) => Promise<T>,
) {
  const effect = Effect.flatMap(
    mcpEffectBoundary.tryPromise(() => resolveMcpServer(server, ctx)),
    (resolved) => {
      if (isMcpResourcesClient(resolved)) {
        return mcpEffectBoundary.tryPromise(
          signal => callback(resolved, withRequestSignal(request, signal)),
        )
      }
      return Effect.acquireUseRelease(
        mcpEffectBoundary.tryPromise(() => createMcpClient(resolved)),
        ({ client, transport }) => mcpEffectBoundary.tryPromise(
          signal => client.connect(transport, { signal }),
        ).pipe(
          Effect.andThen(mcpEffectBoundary.tryPromise(
            signal => callback(client, withRequestSignal(request, signal)),
          )),
        ),
        ({ client }) => mcpEffectBoundary.tryPromise(() => client.close?.()),
      )
    },
  )
  return await mcpEffectBoundary.run(effect, { signal: ctx.abortSignal })
}

function extensionForMimeType(mimeType: string | undefined) {
  if (!mimeType) return
  if (mimeType === "application/json") return "json"
  if (mimeType === "text/markdown") return "md"
  if (mimeType === "text/plain") return "txt"
  if (mimeType === "text/html") return "html"
  if (mimeType === "application/xml" || mimeType === "text/xml") return "xml"
  if (mimeType === "application/octet-stream") return "bin"
}

function normalizePathSegment(input: string) {
  return input
    .normalize("NFKD")
    .replace(/\\/g, "/")
    .replace(/[^\w./-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/(^|\/)\.+(?=\/|$)/g, "")
    .replace(/^-+|-+$/g, "")
}

function defaultResourcePath(resource: McpResourceDescriptor) {
  let path = ""
  try {
    const url = new URL(resource.uri)
    const protocol = url.protocol.replace(/:$/, "")
    const host = url.hostname || url.host
    const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "")
    path = [host, pathname || resource.name || protocol].filter(Boolean).join("/")
  }
  catch {
    path = resource.name || resource.uri
  }

  let normalized = normalizePathSegment(path)
  if (!normalized) normalized = normalizePathSegment(resource.name || resource.uri)
  const extension = extensionForMimeType(resource.mimeType)
  if (extension && !normalized.split("/").at(-1)?.includes(".")) {
    normalized = `${normalized}.${extension}`
  }
  return normalizeSafeSourcePath(normalized)
}

function resourcePathNeedsContentMimeType(resource: McpResourceDescriptor, options: McpResourcesSourceOptions) {
  if (options.path || resource.mimeType) return false
  const path = defaultResourcePath(resource)
  return !path.split("/").at(-1)?.includes(".")
}

function resourceWithContentMimeType(resource: McpResourceDescriptor, contents: McpResourceContent[]) {
  if (resource.mimeType) return resource
  const content = contents.find(item => item.uri === resource.uri) || contents[0]
  const mimeType = contents.length > 1 ? "application/json" : content?.mimeType
  return mimeType ? { ...resource, mimeType } : resource
}

function resourceKey<TKey extends string>(resource: McpResourceDescriptor, options: McpResourcesSourceOptions<TKey>) {
  const resolved = options.path?.(resource) ?? defaultResourcePath(resource)
  return normalizeSafeSourcePath(resolved) as TKey
}

function shouldInclude(path: string, options: Pick<McpResourcesSourceOptions, "ignore" | "include">) {
  if (options.include && !matchesAny(path, options.include)) return false
  if (options.ignore && matchesAny(path, options.ignore)) return false
  return true
}

type McpRecord = Record<PropertyKey, unknown>

function isRecord(value: unknown): value is McpRecord {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- MCP responses cross a runtime protocol boundary.
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMcpString(value: unknown): value is string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- MCP responses cross a runtime protocol boundary.
  return typeof value === "string"
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false
  }
  return true
}

function isOwnMcpString(value: McpRecord, key: PropertyKey): boolean {
  return Object.hasOwn(value, key) && isMcpString(Reflect.get(value, key))
}

function hasOptionalMcpString(value: McpRecord, key: PropertyKey): boolean {
  return hasOptionalMcpField(value, key, isMcpString)
}

function hasOptionalMcpField(value: McpRecord, key: PropertyKey, validate: (field: unknown) => boolean): boolean {
  if (!Reflect.has(value, key)) return true
  if (!Object.hasOwn(value, key)) return false
  const field = Reflect.get(value, key)
  return field === undefined || validate(field)
}

function isMcpNumber(value: unknown): value is number {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- MCP numeric metadata crosses a runtime protocol boundary.
  return typeof value === "number" && Number.isFinite(value)
}

function isMcpMetadata(value: unknown): boolean {
  return ResourceContentsSchema.shape._meta.safeParse(value).success
}

function isMcpArrayOf(value: unknown, validate: (entry: unknown) => boolean): boolean {
  return isDenseArray(value) && value.every(validate)
}

function isResourceAnnotations(value: unknown): boolean {
  return isRecord(value)
    && hasOptionalMcpField(value, "audience", audience => isMcpArrayOf(audience, role => role === "assistant" || role === "user"))
    && hasOptionalMcpString(value, "lastModified")
    && hasOptionalMcpField(value, "priority", isMcpNumber)
    && AnnotationsSchema.safeParse(value).success
}

function isResourceIcon(value: unknown): boolean {
  return isRecord(value)
    && isOwnMcpString(value, "src")
    && hasOptionalMcpString(value, "mimeType")
    && hasOptionalMcpField(value, "sizes", sizes => isMcpArrayOf(sizes, isMcpString))
    && hasOptionalMcpField(value, "theme", theme => theme === "dark" || theme === "light")
}

function isResourceDescriptor(value: unknown): value is McpResourceDescriptor {
  return isRecord(value)
    && isOwnMcpString(value, "name")
    && isOwnMcpString(value, "uri")
    && hasOptionalMcpString(value, "mimeType")
    && hasOptionalMcpString(value, "title")
    && hasOptionalMcpString(value, "description")
    && hasOptionalMcpField(value, "size", isMcpNumber)
    && hasOptionalMcpField(value, "_meta", isMcpMetadata)
    && hasOptionalMcpField(value, "annotations", isResourceAnnotations)
    && hasOptionalMcpField(value, "icons", icons => isMcpArrayOf(icons, isResourceIcon))
}

function isResourceContent(value: unknown): value is McpResourceContent {
  if (!isRecord(value)
    || !isOwnMcpString(value, "uri")
    || !hasOptionalMcpString(value, "mimeType")
    || !hasOptionalMcpField(value, "_meta", isMcpMetadata)) return false
  const hasTextKey = Object.hasOwn(value, "text")
  const hasBlobKey = Object.hasOwn(value, "blob")
  const hasText = hasTextKey && isMcpString(Reflect.get(value, "text"))
  const hasBlob = hasBlobKey && BlobResourceContentsSchema.safeParse(value).success
  return hasText !== hasBlob && (!hasTextKey || hasText) && (!hasBlobKey || hasBlob)
}

function parseResourceListPage(value: unknown): { nextCursor?: string, resources: McpResourceDescriptor[] } {
  if (!isRecord(value)) {
    throw sourceError("[vitehub] mcpResources server returned an invalid listResources response.")
  }
  if (!Object.hasOwn(value, "resources") || (Reflect.has(value, "nextCursor") && !Object.hasOwn(value, "nextCursor"))) {
    throw sourceError("[vitehub] mcpResources server returned an invalid listResources response.")
  }
  const resources = Reflect.get(value, "resources")
  const nextCursor = Object.hasOwn(value, "nextCursor") ? Reflect.get(value, "nextCursor") : undefined
  if (!isDenseArray(resources) || resources.some(resource => !isResourceDescriptor(resource)) || (nextCursor !== undefined && !isMcpString(nextCursor))) {
    throw sourceError("[vitehub] mcpResources server returned an invalid listResources response.")
  }
  // SAFETY: Every resource field declared by McpResourceDescriptor has passed validation.
  return { nextCursor, resources: resources as McpResourceDescriptor[] }
}

function parseResourceContents(value: unknown): McpResourceContent[] {
  if (!isRecord(value)) {
    throw sourceError("[vitehub] mcpResources server returned an invalid readResource response.")
  }
  if (!Object.hasOwn(value, "contents")) {
    throw sourceError("[vitehub] mcpResources server returned an invalid readResource response.")
  }
  const contents = Reflect.get(value, "contents")
  if (!isDenseArray(contents) || contents.some(content => !isResourceContent(content))) {
    throw sourceError("[vitehub] mcpResources server returned an invalid readResource response.")
  }
  // SAFETY: Every content entry is an object with the string URI required by the MCP response contract.
  return contents as McpResourceContent[]
}

async function listAllResources(client: McpResourcesClient, request: McpResourcesRequestOptions | undefined) {
  const resources: McpResourceDescriptor[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw sourceError("[vitehub] mcpResources server returned the same pagination cursor twice.")
      }
      seenCursors.add(cursor)
    }
    const page = parseResourceListPage(await client.listResources(cursor === undefined ? undefined : { cursor }, request))
    resources.push(...page.resources)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return resources
}

async function readResourceContents(
  client: McpResourcesClient,
  resource: McpResourceDescriptor,
  request: McpResourcesRequestOptions | undefined,
) {
  return parseResourceContents(await client.readResource({ uri: resource.uri }, request))
}

async function createEntries<TKey extends string>(
  resources: McpResourceDescriptor[],
  options: McpResourcesSourceOptions<TKey>,
  client?: McpResourcesClient,
) {
  const entries: ResourceEntry<TKey>[] = []
  const seen = new Map<string, string>()
  for (const resource of resources) {
    let contents: McpResourceContent[] | undefined
    let resolvedResource = resource
    if (client && resourcePathNeedsContentMimeType(resource, options)) {
      contents = await readResourceContents(client, resource, options.request)
      resolvedResource = resourceWithContentMimeType(resource, contents)
    }
    const key = resourceKey(resolvedResource, options)
    if (!shouldInclude(key, options)) continue
    const existingUri = seen.get(key)
    if (existingUri) {
      throw sourceError(`[vitehub] mcpResources produced duplicate path ${JSON.stringify(key)} for ${JSON.stringify(existingUri)} and ${JSON.stringify(resource.uri)}.`)
    }
    seen.set(key, resource.uri)
    entries.push({ contents, key, resource: resolvedResource })
  }
  return entries
}

function decodeBase64(value: string) {
  const normalized = value.replace(/[\t\n\f\r ]/g, "")
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 || /=[A-Za-z0-9+/]/.test(normalized)) {
    throw sourceError("[vitehub] MCP resource returned invalid base64 content.")
  }
  if (globalThis.Buffer) return new Uint8Array(globalThis.Buffer.from(normalized, "base64"))
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function contentToSourceContent(content: McpResourceContent): SourceContent {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Remote MCP text content must be an own string field before decoding.
  if (Object.hasOwn(content, "text") && "text" in content && typeof content.text === "string") return content.text
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Remote MCP binary content must be an own string field before base64 decoding.
  if (Object.hasOwn(content, "blob") && "blob" in content && typeof content.blob === "string") return decodeBase64(content.blob)
  return ""
}

function createResourceItem<TKey extends string>(
  key: TKey,
  resource: McpResourceDescriptor,
  contents: McpResourceContent[],
) {
  const content = contents.find(item => item.uri === resource.uri) || contents[0]
  if (!content) {
    throw sourceError(`[vitehub] mcpResources could not read resource ${JSON.stringify(resource.uri)}.`)
  }
  const multipleContents = contents.length > 1
  const metadata: Record<string, unknown> = {
    name: resource.name,
    serverResourceCount: contents.length,
    uri: resource.uri,
  }
  if (resource.description !== undefined) metadata.description = resource.description
  if (resource.size !== undefined) metadata.size = resource.size
  if (resource.title !== undefined) metadata.title = resource.title
  return {
    key,
    path: key,
    content: multipleContents ? JSON.stringify(contents, null, 2) : contentToSourceContent(content),
    mediaType: multipleContents ? "application/json" : content.mimeType || resource.mimeType,
    metadata,
  }
}

export function mcpResources<const TKey extends string = string>(options: McpResourcesSourceOptions<TKey>): FileSource<TKey> {
  if (!options || typeof options !== "object" || !hasDeclaredProperty(options, "server") || !options.server) {
    throw sourceErrorDiagnostics.SOURCE_R0022({ message: "[vitehub] mcpResources({ server }) requires an MCP server." })
  }

  async function getEntries(ctx: SourceContext) {
    return await withMcpClient(options.server, ctx, options.request, async (client, request) => {
      return await createEntries(await listAllResources(client, request), { ...options, request }, client)
    })
  }

  async function getItems(ctx: SourceContext) {
    return await withMcpClient(options.server, ctx, options.request, async (client, request) => {
      const scopedOptions = { ...options, request }
      const entries = await createEntries(await listAllResources(client, request), scopedOptions, client)
      return await Promise.all(entries.map(async ({ contents, key, resource }) => {
        const result = contents ?? await readResourceContents(client, resource, request)
        return createResourceItem(key, resource, result)
      }))
    })
  }

  return {
    cache: options.cache,
    fingerprint: {
      ignore: options.ignore,
      include: options.include,
      server: typeof options.server === "function"
        ? "[function]"
        : isMcpResourcesClient(options.server)
          ? { client: true, serverInfo: options.server.serverInfo }
          : options.server,
    },
    name: "mcpResources",
    async getKeys(ctx) {
      return (await getEntries(ctx)).map(entry => entry.key)
    },
    async getItems(ctx) {
      return await getItems(ctx)
    },
    async getMeta(key, ctx) {
      const entry = (await getEntries(ctx)).find(entry => entry.key === key)
      if (!entry) return
      return {
        description: entry.resource.description,
        mimeType: entry.resource.mimeType,
        name: entry.resource.name,
        size: entry.resource.size,
        title: entry.resource.title,
        uri: entry.resource.uri,
      }
    },
    async getItem(key, ctx) {
      return await withMcpClient(options.server, ctx, options.request, async (client, request) => {
        const entry = (await createEntries(await listAllResources(client, request), { ...options, request }, client)).find(entry => entry.key === key)
        if (!entry) {
          throw sourceError(`[vitehub] mcpResources could not find ${JSON.stringify(key)}.`)
        }
        const result = entry.contents ?? await readResourceContents(client, entry.resource, request)
        return createResourceItem(key, entry.resource, result)
      })
    },
  }
}
