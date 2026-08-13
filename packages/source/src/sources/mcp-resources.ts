import { createEffectBoundary } from "@vite-hub/internal/effect"
import { Effect } from "effect"

import { sourceError } from "../core/errors.ts"
import { normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"
import { matchesAny } from "./path.ts"

import type { Source, SourceCacheOptions, SourceContent, SourceContext } from "../core/types.ts"
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"

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

export type McpResourcesMessage =
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
  exclude?: string | string[]
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
    && typeof (value as { listResources?: unknown }).listResources === "function"
    && typeof (value as { readResource?: unknown }).readResource === "function"
}

function isMcpResourcesClientConfig(value: unknown): value is McpResourcesClientConfig {
  return typeof value === "object"
    && value !== null
    && "transport" in value
}

function isMcpTransport(value: unknown): value is McpResourcesTransport {
  return typeof value === "object"
    && value !== null
    && typeof (value as { close?: unknown }).close === "function"
    && typeof (value as { send?: unknown }).send === "function"
    && typeof (value as { start?: unknown }).start === "function"
}

async function createMcpTransport(config: McpResourcesTransportConfig): Promise<Transport> {
  if (isMcpTransport(config)) return config as unknown as Transport
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
  throw new TypeError("[vitehub] mcpResources({ server }) must resolve to an MCP client or MCP client config.")
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
            signal => callback(client as unknown as McpResourcesClient, withRequestSignal(request, signal)),
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

function shouldInclude(path: string, options: Pick<McpResourcesSourceOptions, "include" | "exclude">) {
  if (options.include && !matchesAny(path, options.include)) return false
  if (options.exclude && matchesAny(path, options.exclude)) return false
  return true
}

async function listAllResources(client: McpResourcesClient, request: McpResourcesRequestOptions | undefined) {
  const resources: McpResourceDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await client.listResources(cursor ? { cursor } : undefined, request)
    resources.push(...page.resources)
    cursor = page.nextCursor
  } while (cursor)
  return resources
}

async function readResourceContents(
  client: McpResourcesClient,
  resource: McpResourceDescriptor,
  request: McpResourcesRequestOptions | undefined,
) {
  return (await client.readResource({ uri: resource.uri }, request)).contents
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
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"))
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function contentToSourceContent(content: McpResourceContent): SourceContent {
  if ("text" in content && typeof content.text === "string") return content.text
  if ("blob" in content && typeof content.blob === "string") return decodeBase64(content.blob)
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
  return {
    key,
    path: key,
    content: multipleContents ? JSON.stringify(contents, null, 2) : contentToSourceContent(content),
    mediaType: multipleContents ? "application/json" : content.mimeType || resource.mimeType,
    metadata: {
      description: resource.description,
      name: resource.name,
      serverResourceCount: contents.length,
      size: resource.size,
      title: resource.title,
      uri: resource.uri,
    },
  }
}

export function mcpResources<const TKey extends string = string>(options: McpResourcesSourceOptions<TKey>): Source<TKey> {
  if (!options || typeof options !== "object" || !options.server) {
    throw new TypeError("[vitehub] mcpResources({ server }) requires an MCP server.")
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
      exclude: options.exclude,
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
    async search(query, ctx) {
      const pattern = query.regex ? new RegExp(query.pattern, query.caseSensitive ? "g" : "gi") : undefined
      const search = query.caseSensitive ? query.pattern : query.pattern.toLowerCase()
      const results = []
      for (const item of await getItems(ctx)) {
        if (typeof item.content !== "string") continue
        if (query.paths?.length && !query.paths.some(path => item.path && normalizeSourcePath(item.path).startsWith(normalizeSourcePath(path)))) continue
        const lines = item.content.split(/\r?\n/)
        for (const [index, line] of lines.entries()) {
          const matchIndex = pattern
            ? line.search(pattern)
            : (query.caseSensitive ? line : line.toLowerCase()).indexOf(search)
          if (matchIndex === -1) continue
          results.push({
            column: matchIndex + 1,
            line: index + 1,
            path: item.path || item.key,
            text: line,
          })
          if (query.limit && results.length >= query.limit) return results
        }
      }
      return results
    },
  }
}
