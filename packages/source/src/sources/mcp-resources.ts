import {
  SourceError,
  sourceItemNotFoundError,
  sourceProviderRequestError,
  sourceProviderResponseInvalidError,
} from "../core/errors.ts"
import { matchesAny, normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"

import type { SourceProviderOperation } from "../core/errors.ts"
import type { Source, SourceCacheOptions, SourceContent, SourceContext } from "../core/types.ts"
import type { Client as SdkMcpClient } from "@modelcontextprotocol/sdk/client/index.js"
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js"
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { BlobResourceContents, Resource, TextResourceContents } from "@modelcontextprotocol/sdk/types.js"

export type McpResourcesRequestOptions = RequestOptions

export type McpResourceDescriptor = Resource

export type McpResourceContent = TextResourceContents | BlobResourceContents

export interface McpResourcesClient {
  close?: () => void | Promise<void>
  getServerVersion?: SdkMcpClient["getServerVersion"]
  listResources: SdkMcpClient["listResources"]
  readResource: SdkMcpClient["readResource"]
  serverInfo?: unknown
}

export type McpResourcesTransportConfig =
  | Transport
  | ({ type?: "http", url: string | URL } & StreamableHTTPClientTransportOptions)
  | ({ type: "sse", url: string | URL } & SSEClientTransportOptions)

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

function isMcpTransport(value: unknown): value is Transport {
  return typeof value === "object"
    && value !== null
    && typeof (value as { close?: unknown }).close === "function"
    && typeof (value as { send?: unknown }).send === "function"
    && typeof (value as { start?: unknown }).start === "function"
}

async function createMcpTransport(config: McpResourcesTransportConfig): Promise<Transport> {
  if (isMcpTransport(config)) return config
  const { type = "http", url, ...options } = config
  if (type === "sse") {
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js")
    return new SSEClientTransport(new URL(url), options)
  }
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  return new StreamableHTTPClientTransport(new URL(url), options)
}

async function createMcpClient(config: McpResourcesClientConfig, signal?: AbortSignal): Promise<McpResourcesClient> {
  return await runMcpProviderOperation("connect", undefined, signal, async () => {
    const [{ Client }, transport] = await Promise.all([
      import("@modelcontextprotocol/sdk/client/index.js"),
      createMcpTransport(config.transport),
    ])
    const client = new Client({
      name: "vitehub-source",
      version: "0.0.1",
    })
    await client.connect(transport)
    return client
  })
}

async function resolveMcpClient(server: McpResourcesServer, ctx: SourceContext) {
  const resolved = typeof server === "function"
    ? await runMcpProviderOperation("resolve", undefined, ctx.abortSignal, () => server(ctx))
    : server
  if (isMcpResourcesClient(resolved)) {
    return { client: resolved, ownsClient: false }
  }
  if (isMcpResourcesClientConfig(resolved)) {
    return { client: await createMcpClient(resolved, ctx.abortSignal), ownsClient: true }
  }
  throw new TypeError("[vitehub] mcpResources({ server }) must resolve to an MCP client or MCP client config.")
}

async function withMcpClient<T>(server: McpResourcesServer, ctx: SourceContext, callback: (client: McpResourcesClient) => Promise<T>) {
  const { client, ownsClient } = await resolveMcpClient(server, ctx)
  try {
    return await callback(client)
  }
  finally {
    if (ownsClient && client.close) {
      await runMcpProviderOperation("close", undefined, ctx.abortSignal, () => client.close!())
    }
  }
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

async function listAllResources(client: McpResourcesClient, request: McpResourcesRequestOptions | undefined, signal?: AbortSignal) {
  const resources: McpResourceDescriptor[] = []
  let cursor: string | undefined
  do {
    const page = await runMcpProviderOperation(
      "list-resources",
      request,
      signal,
      () => client.listResources(cursor ? { cursor } : undefined, request),
    )
    resources.push(...page.resources)
    cursor = page.nextCursor
  } while (cursor)
  return resources
}

async function readResourceContents(
  client: McpResourcesClient,
  resource: McpResourceDescriptor,
  request: McpResourcesRequestOptions | undefined,
  signal?: AbortSignal,
) {
  const response = await runMcpProviderOperation(
    "read-resource",
    request,
    signal,
    () => client.readResource({ uri: resource.uri }, request),
  )
  return response.contents
}

async function createEntries<TKey extends string>(
  resources: McpResourceDescriptor[],
  options: McpResourcesSourceOptions<TKey>,
  client?: McpResourcesClient,
  signal?: AbortSignal,
) {
  const entries: ResourceEntry<TKey>[] = []
  const seen = new Map<string, string>()
  for (const resource of resources) {
    let contents: McpResourceContent[] | undefined
    let resolvedResource = resource
    if (client && resourcePathNeedsContentMimeType(resource, options)) {
      contents = await readResourceContents(client, resource, options.request, signal)
      resolvedResource = resourceWithContentMimeType(resource, contents)
    }
    const key = resourceKey(resolvedResource, options)
    if (!shouldInclude(key, options)) continue
    const existingUri = seen.get(key)
    if (existingUri) {
      throw sourceProviderResponseInvalidError("mcp", "list-resources", { key })
    }
    seen.set(key, resource.uri)
    entries.push({ contents, key, resource: resolvedResource })
  }
  return entries
}

function decodeBase64(value: string) {
  const normalized = value.replace(/\s/g, "")
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}(?:==)?|[A-Za-z\d+/]{3}=?|)$/.test(normalized)) {
    throw new TypeError("[vitehub] MCP resource blob is not valid base64.")
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(normalized, "base64"))
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function contentToSourceContent(content: McpResourceContent, key: string): SourceContent {
  if ("text" in content && typeof content.text === "string") return content.text
  if ("blob" in content && typeof content.blob === "string") {
    try {
      return decodeBase64(content.blob)
    }
    catch {
      throw sourceProviderResponseInvalidError("mcp", "read-resource", { cause: content, key })
    }
  }
  throw sourceProviderResponseInvalidError("mcp", "read-resource", { cause: content, key })
}

function createResourceItem<TKey extends string>(
  key: TKey,
  resource: McpResourceDescriptor,
  contents: McpResourceContent[],
) {
  const content = contents.find(item => item.uri === resource.uri) || contents[0]
  if (!content) {
    throw sourceProviderResponseInvalidError("mcp", "read-resource", { key })
  }
  const sourceContents = contents.map(item => contentToSourceContent(item, key))
  const multipleContents = contents.length > 1
  return {
    key,
    path: key,
    content: multipleContents ? JSON.stringify(contents, null, 2) : sourceContents[contents.indexOf(content)]!,
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
    return await withMcpClient(options.server, ctx, async (client) => {
      return await createEntries(await listAllResources(client, options.request, ctx.abortSignal), options, client, ctx.abortSignal)
    })
  }

  async function getItems(ctx: SourceContext) {
    return await withMcpClient(options.server, ctx, async (client) => {
      const entries = await createEntries(await listAllResources(client, options.request, ctx.abortSignal), options, client, ctx.abortSignal)
      return await Promise.all(entries.map(async ({ contents, key, resource }) => {
        const result = contents ?? await readResourceContents(client, resource, options.request, ctx.abortSignal)
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
      return await withMcpClient(options.server, ctx, async (client) => {
        const entry = (await createEntries(
          await listAllResources(client, options.request, ctx.abortSignal),
          options,
          client,
          ctx.abortSignal,
        )).find(entry => entry.key === key)
        if (!entry) {
          throw sourceItemNotFoundError("mcpResources", key)
        }
        const result = entry.contents ?? await readResourceContents(client, entry.resource, options.request, ctx.abortSignal)
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

async function runMcpProviderOperation<TResult>(
  operation: SourceProviderOperation,
  request: McpResourcesRequestOptions | undefined,
  signal: AbortSignal | undefined,
  run: () => Promise<TResult> | TResult,
): Promise<TResult> {
  try {
    return await run()
  }
  catch (cause) {
    if (signal?.aborted) throw signal.reason
    if (request?.signal?.aborted) throw request.signal.reason
    if (cause instanceof SourceError) throw cause
    throw sourceProviderRequestError("mcp", operation, { cause })
  }
}
