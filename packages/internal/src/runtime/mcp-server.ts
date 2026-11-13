import { forwardedRequestOrigin } from "./request-origin.ts"

/**
 * The MCP server of ViteHub: the Console MCP at `/_vitehub/mcp` and the app MCP of `vite-hub/mcp` answer through it.
 * It has no MCP library and no session.
 */

/** MCP revisions that this server answers, newest first. It speaks the stateless JSON subset of Streamable HTTP. */
export const mcpProtocolVersions: readonly string[] = ["2025-11-25", "2025-06-18"]

/** One block of a tool result, such as `{ type: "text", text }`. */
export type McpContentBlock = { type: "text", text: string } | { type: string, [key: string]: unknown }

/** The result of `tools/call`. */
export interface McpToolResult {
  content: McpContentBlock[]
  structuredContent?: Record<string, unknown>
  isError: boolean
}

/** The MCP tool annotations that clients read before a call. */
export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** A tool as `tools/list` shows it, with the handler that `tools/call` runs. It has the shape of an okmcp `defineTool()`. */
export interface McpTool {
  name: string
  title?: string
  description: string
  annotations?: McpToolAnnotations
  /** The JSON Schema of the arguments, an object schema. */
  inputSchema: object
  /**
   * Checks the arguments before the handler runs and returns the problems, or nothing when they are valid. Since
   * 2025-11-25 a problem is a tool error, which the Agent reads. Older clients get JSON-RPC `-32602`. A tool without it
   * checks its input in the handler.
   */
  validate?: (input: Record<string, unknown>) => string | undefined | Promise<string | undefined>
  /** The largest `tools/call` request for this tool, in bytes. Without it, the server limit applies. */
  maxRequestBytes?: number
  /** The OAuth scopes that a call needs. A caller without them does not see the tool. */
  scopes?: readonly string[]
  handler(input: Record<string, unknown>): Promise<McpToolResult>
}

/** An icon that clients show for the server. `src` is an `https:` or `data:` URI. */
export interface McpIcon {
  src: string
  mimeType?: string
  /** Sizes such as `"48x48"`, or `"any"` for a scalable image. */
  sizes?: string[]
  theme?: "light" | "dark"
}

/** The `serverInfo` of `initialize`: who the server is. */
export interface McpServerInfo {
  name: string
  title: string
  version: string
  description?: string
  websiteUrl?: string
  icons?: McpIcon[]
}

/** One argument of a prompt as `prompts/list` shows it. Prompt arguments are strings. */
export interface McpPromptArgument {
  name: string
  title?: string
  description?: string
  required?: boolean
}

/** One message of a prompt. */
export interface McpPromptMessage {
  role: "user" | "assistant"
  content: McpContentBlock
}

/** The result of `prompts/get`. */
export interface McpPromptResult {
  description?: string
  messages: McpPromptMessage[]
}

/** A prompt as `prompts/list` shows it, with the function that `prompts/get` runs. */
export interface McpPrompt {
  name: string
  title?: string
  description?: string
  arguments?: McpPromptArgument[]
  /** Throw {@link McpMethodError} to answer with a JSON-RPC error, such as `-32602` for invalid arguments. */
  get(input: Record<string, string>): Promise<McpPromptResult>
}

/** The contents of one resource in `resources/read`: text, or base64 bytes in `blob`. */
export type McpResourceContents = { uri: string, mimeType?: string, text: string } | { uri: string, mimeType?: string, blob: string }

/** A resource as `resources/list` shows it. */
export interface McpListedResource {
  uri: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

/**
 * A resource with a fixed `uri`, or a family of resources with a `uriTemplate`. `resources/read` reads the first
 * resource with that `uri`, else the first template that matches.
 */
export interface McpResource {
  name: string
  title?: string
  description?: string
  mimeType?: string
  /** The URI of one resource. */
  uri?: string
  /** An RFC 6570 URI template. `{name}` matches one path segment, and `{+name}` also matches `/`. */
  uriTemplate?: string
  /** The resources of a template that `resources/list` shows. */
  list?: () => Promise<McpListedResource[]>
  /**
   * Returns the contents, or `undefined` when no such resource exists. `variables` are the values of the template.
   * Throw {@link McpMethodError} to answer with another JSON-RPC error.
   */
  read(uri: string, variables: Record<string, string>): Promise<McpResourceContents[] | undefined>
}

/** An error that a prompt or resource throws to answer with this JSON-RPC error. */
export class McpMethodError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = "McpMethodError"
  }
}

/** What one request may see: the server identity and the tools, prompts, and resources of the caller. */
export interface McpServer {
  serverInfo: McpServerInfo
  instructions: string
  tools: readonly McpTool[]
  /** With prompts, `initialize` advertises the `prompts` capability. */
  prompts?: readonly McpPrompt[]
  /** With resources, `initialize` advertises the `resources` capability. */
  resources?: readonly McpResource[]
  /** The scopes of the caller's access token. Without them, as for a session, no scope check applies. */
  scopes?: readonly string[]
  /** The `WWW-Authenticate` value of a `403` for a call that lacks `scopes`, so the client asks for them. */
  challenge?: (scopes: readonly string[]) => Promise<string>
}

type JsonRpcId = string | number | null

const maximumBodyBytes = 2 * 1_024 * 1_024
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" }
const tooLargeBody: unique symbol = Symbol("too large")

/** Reads the body as text and stops after `limit` bytes, since a client can leave out or lie about content-length. */
async function readText(body: ReadableStream<Uint8Array>, limit: number): Promise<string | typeof tooLargeBody> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined)
        return tooLargeBody
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  }
  finally {
    reader.releaseLock()
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function reply(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers })
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200, data?: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, { headers, status })
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Matches `uri` against an RFC 6570 template and returns the values of its variables. `{name}` matches one path
 * segment, and `{+name}` also matches `/`. Other operators match nothing.
 */
export function matchMcpUriTemplate(template: string, uri: string): Record<string, string> | undefined {
  const names: string[] = []
  const pattern = template.split(/(\{[^}]*\})/).map((part) => {
    const variable = /^\{(\+?)([\w.]+)\}$/.exec(part)
    if (!variable) return escapeRegExp(part)
    names.push(variable[2]!)
    return variable[1] ? "(.+)" : "([^/?#]+)"
  }).join("")
  const match = new RegExp(`^${pattern}$`).exec(uri)
  if (!match) return undefined
  try {
    return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]))
  }
  catch {
    return undefined
  }
}

async function readResource(server: McpServer, uri: string): Promise<McpResourceContents[] | undefined> {
  const resources = server.resources ?? []
  const fixed = resources.find(resource => resource.uri === uri)
  if (fixed) return await fixed.read(uri, {})
  for (const resource of resources) {
    const variables = resource.uriTemplate === undefined ? undefined : matchMcpUriTemplate(resource.uriTemplate, uri)
    if (variables) return await resource.read(uri, variables)
  }
  return undefined
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const entries = record(value)
  if (!entries || !Object.values(entries).every(entry => typeof entry === "string")) return undefined
  // SAFETY: Every value is a string, checked above.
  return entries as Record<string, string>
}

/** Answers a prompt or resource method, and turns a thrown {@link McpMethodError} into its JSON-RPC error. */
async function answer(id: JsonRpcId, run: () => Promise<unknown>): Promise<Response> {
  try {
    return reply(id, await run())
  }
  catch (error) {
    if (error instanceof McpMethodError) return rpcError(id, error.code, error.message, 200, error.data)
    console.error("[vitehub] MCP request failed:", error)
    return rpcError(id, -32603, "The request failed on the server.")
  }
}

function missingScopes(server: McpServer, tool: McpTool): string[] {
  const granted = server.scopes
  return granted ? (tool.scopes ?? []).filter(scope => !granted.includes(scope)) : []
}

/**
 * Answer one MCP request: JSON-RPC parsing, revision negotiation, `initialize`, `ping`, the `tools/*` methods, and the
 * `prompts/*` and `resources/*` methods when the server has prompts or resources.
 * It holds no session, so every POST carries one message and gets one JSON answer.
 */
export async function serveMcp(request: Request, server: McpServer): Promise<Response> {
  if (request.method !== "POST") {
    const response = rpcError(null, -32600, `${server.serverInfo.title} accepts JSON-RPC requests with POST. It has no event stream.`, 405)
    response.headers.set("allow", "POST")
    return response
  }
  // Browsers send Origin. A page on another origin must not drive the tools with the person's cookie.
  const origin = request.headers.get("origin")
  if (origin && origin !== forwardedRequestOrigin(request)) return rpcError(null, -32600, `This origin may not call ${server.serverInfo.title}.`, 403)
  // Read no more than the largest tool allows. The limit of the called tool is checked before it runs.
  const readLimit = Math.max(maximumBodyBytes, ...server.tools.map(tool => tool.maxRequestBytes ?? 0))
  const tooLarge = (limit: number) => rpcError(null, -32600, `The request is larger than ${limit} bytes.`, 413)
  let message: Record<string, unknown> | undefined
  let bytes = 0
  try {
    const text = request.body ? await readText(request.body, readLimit) : ""
    if (text === tooLargeBody) return tooLarge(readLimit)
    bytes = new TextEncoder().encode(text).byteLength
    message = record(JSON.parse(text))
  }
  catch {
    return rpcError(null, -32700, "The body is not one JSON-RPC message.", 400)
  }
  if (!message || message.jsonrpc !== "2.0") return rpcError(null, -32600, "The body is not one JSON-RPC message.", 400)
  // MCP request ids are strings or numbers, never null. A message without an id is a notification.
  const raw = message.id
  const id: JsonRpcId = typeof raw === "string" || (typeof raw === "number" && Number.isFinite(raw)) ? raw : null
  if ("id" in message && id === null) return rpcError(null, -32600, "The request id must be a string or a number.", 400)
  const method = message.method
  if (typeof method !== "string" || !method) return rpcError(id, -32600, "A request needs a method, such as tools/list.", 400)
  const version = request.headers.get("mcp-protocol-version")
  if (method !== "initialize" && version !== null && !mcpProtocolVersions.includes(version)) {
    return rpcError(id, -32600, `Unsupported MCP-Protocol-Version ${JSON.stringify(version)}. This server speaks ${mcpProtocolVersions.join(", ")}.`, 400)
  }
  // A notification, such as `notifications/initialized`, gets no answer.
  if (!("id" in message)) return new Response(null, { headers, status: 202 })
  const params = record(message.params) ?? {}
  const called = method === "tools/call" ? server.tools.find(candidate => candidate.name === params.name) : undefined
  const limit = called?.maxRequestBytes ?? maximumBodyBytes
  if (bytes > limit) return tooLarge(limit)
  const names = new Set(server.tools.map(tool => tool.name))
  if (names.size !== server.tools.length) return rpcError(id, -32603, "Two tools of this server have the same name.", 500)
  const prompts = server.prompts ?? []
  const resources = server.resources ?? []

  if (prompts.length && method === "prompts/list") {
    return reply(id, {
      prompts: prompts.map(prompt => ({
        name: prompt.name,
        ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
        ...(prompt.arguments?.length ? { arguments: prompt.arguments } : {}),
      })),
    })
  }
  if (prompts.length && method === "prompts/get") {
    const prompt = prompts.find(candidate => candidate.name === params.name)
    if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${String(params.name)}. Call prompts/list for the prompts of this server.`)
    const input = params.arguments === undefined ? {} : stringRecord(params.arguments)
    if (!input) return rpcError(id, -32602, `Invalid arguments for ${prompt.name}: expected an object of strings.`)
    return await answer(id, () => prompt.get(input))
  }
  if (resources.length && method === "resources/list") {
    return await answer(id, async () => {
      const listed = await Promise.all(resources.map(async (resource): Promise<McpListedResource[]> => {
        if (resource.uri !== undefined) {
          return [{
            uri: resource.uri,
            name: resource.name,
            ...(resource.title ? { title: resource.title } : {}),
            ...(resource.description ? { description: resource.description } : {}),
            ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
          }]
        }
        return await resource.list?.() ?? []
      }))
      return { resources: listed.flat() }
    })
  }
  if (resources.length && method === "resources/templates/list") {
    return reply(id, {
      resourceTemplates: resources.filter(resource => resource.uriTemplate !== undefined).map(resource => ({
        uriTemplate: resource.uriTemplate,
        name: resource.name,
        ...(resource.title ? { title: resource.title } : {}),
        ...(resource.description ? { description: resource.description } : {}),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      })),
    })
  }
  if (resources.length && method === "resources/read") {
    const uri = params.uri
    if (typeof uri !== "string" || !uri) return rpcError(id, -32602, "resources/read needs a uri.")
    return await answer(id, async () => {
      const contents = await readResource(server, uri)
      if (!contents) throw new McpMethodError(-32002, `Resource not found: ${uri}. Call resources/list or resources/templates/list for the resources of this server.`, { uri })
      return { contents }
    })
  }

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion
      return reply(id, {
        protocolVersion: typeof requested === "string" && mcpProtocolVersions.includes(requested) ? requested : mcpProtocolVersions[0],
        capabilities: {
          tools: { listChanged: false },
          ...(prompts.length ? { prompts: { listChanged: false } } : {}),
          ...(resources.length ? { resources: { subscribe: false, listChanged: false } } : {}),
        },
        serverInfo: server.serverInfo,
        instructions: server.instructions,
      })
    }
    case "ping":
      return reply(id, {})
    case "tools/list":
      return reply(id, {
        tools: server.tools.filter(tool => !missingScopes(server, tool).length).map(tool => ({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      })
    case "tools/call": {
      const tool = called
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}. Call tools/list for the tools this user may use.`)
      const missing = missingScopes(server, tool)
      if (missing.length) {
        const response = rpcError(id, -32001, `This access token lacks the ${missing.join(" ")} scope that ${tool.name} needs. Sign in again and approve it.`, 403)
        if (server.challenge) response.headers.set("www-authenticate", await server.challenge(missing))
        return response
      }
      const input = params.arguments === undefined ? {} : record(params.arguments)
      if (!input) return rpcError(id, -32602, `Invalid arguments for ${tool.name}: expected an object.`)
      const invalid = await tool.validate?.(input)
      // Since 2025-11-25 (SEP-1303), a bad argument is a tool error, so the Agent reads it and calls again.
      if (invalid) return version === "2025-11-25" ? reply(id, { content: [{ type: "text", text: invalid }], isError: true }) : rpcError(id, -32602, invalid)
      return reply(id, await tool.handler(input))
    }
    default:
      return rpcError(id, -32601, `${server.serverInfo.title} has no method ${method}.`)
  }
}
