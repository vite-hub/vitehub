import { SourceError } from "../core/errors.ts"
import { matchesAny, normalizeSafeSourcePath, normalizeSourcePath } from "../core/path.ts"

import type { Source, SourceCacheOptions, SourceContent, SourceContext } from "../core/types.ts"

export interface McpResourcesRequestOptions {
  maxTotalTimeout?: number
  signal?: AbortSignal
  timeout?: number
}

export interface McpResourceDescriptor {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

export interface McpResourceContent {
  uri: string
  name?: string
  title?: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpResourcesClient {
  close?: () => void | Promise<void>
  listResources: (options?: {
    params?: { cursor?: string }
    options?: McpResourcesRequestOptions
  }) => Promise<{
    nextCursor?: string
    resources: McpResourceDescriptor[]
  }>
  readResource: (args: {
    options?: McpResourcesRequestOptions
    uri: string
  }) => Promise<{
    contents: McpResourceContent[]
  }>
  serverInfo?: unknown
}

export interface McpResourcesClientConfig {
  transport: unknown
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

async function createMcpClient(config: McpResourcesClientConfig): Promise<McpResourcesClient> {
  const specifier = ["@ai-sdk", "mcp"].join("/")
  const runtime = await import(specifier) as {
    createMCPClient: (config: unknown) => Promise<McpResourcesClient>
  }
  return await runtime.createMCPClient(config as never)
}

async function resolveMcpClient(server: McpResourcesServer, ctx: SourceContext) {
  const resolved = typeof server === "function" ? await server(ctx) : server
  if (isMcpResourcesClient(resolved)) {
    return { client: resolved, ownsClient: false }
  }
  if (isMcpResourcesClientConfig(resolved)) {
    return { client: await createMcpClient(resolved), ownsClient: true }
  }
  throw new TypeError("[vitehub] source.mcpResources({ server }) must resolve to an MCP client or MCP client config.")
}

async function withMcpClient<T>(server: McpResourcesServer, ctx: SourceContext, callback: (client: McpResourcesClient) => Promise<T>) {
  const { client, ownsClient } = await resolveMcpClient(server, ctx)
  try {
    return await callback(client)
  }
  finally {
    if (ownsClient) await client.close?.()
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
    const page = await client.listResources({
      ...(cursor ? { params: { cursor } } : {}),
      ...(request ? { options: request } : {}),
    })
    resources.push(...page.resources)
    cursor = page.nextCursor
  } while (cursor)
  return resources
}

function createEntries<TKey extends string>(resources: McpResourceDescriptor[], options: McpResourcesSourceOptions<TKey>) {
  const entries: ResourceEntry<TKey>[] = []
  const seen = new Map<string, string>()
  for (const resource of resources) {
    const key = resourceKey(resource, options)
    if (!shouldInclude(key, options)) continue
    const existingUri = seen.get(key)
    if (existingUri) {
      throw new SourceError(`[vitehub] source.mcpResources produced duplicate path ${JSON.stringify(key)} for ${JSON.stringify(existingUri)} and ${JSON.stringify(resource.uri)}.`)
    }
    seen.set(key, resource.uri)
    entries.push({ key, resource })
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
  if (typeof content.text === "string") return content.text
  if (typeof content.blob === "string") return decodeBase64(content.blob)
  return ""
}

function createResourceItem<TKey extends string>(
  key: TKey,
  resource: McpResourceDescriptor,
  contents: McpResourceContent[],
) {
  const content = contents.find(item => item.uri === resource.uri) || contents[0]
  if (!content) {
    throw new SourceError(`[vitehub] source.mcpResources could not read resource ${JSON.stringify(resource.uri)}.`)
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
    throw new TypeError("[vitehub] source.mcpResources({ server }) requires an MCP server.")
  }

  async function getEntries(ctx: SourceContext) {
    return await withMcpClient(options.server, ctx, async (client) => {
      return createEntries(await listAllResources(client, options.request), options)
    })
  }

  async function getItems(ctx: SourceContext) {
    return await withMcpClient(options.server, ctx, async (client) => {
      const entries = createEntries(await listAllResources(client, options.request), options)
      return await Promise.all(entries.map(async ({ key, resource }) => {
        const result = await client.readResource({ uri: resource.uri, ...(options.request ? { options: options.request } : {}) })
        return createResourceItem(key, resource, result.contents)
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
        const entry = createEntries(await listAllResources(client, options.request), options).find(entry => entry.key === key)
        if (!entry) {
          throw new SourceError(`[vitehub] source.mcpResources could not find ${JSON.stringify(key)}.`)
        }
        const result = await client.readResource({ uri: entry.resource.uri, ...(options.request ? { options: options.request } : {}) })
        return createResourceItem(key, entry.resource, result.contents)
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
