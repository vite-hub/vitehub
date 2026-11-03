import { Validator } from "@cfworker/json-schema"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

import { consoleRequestText } from "./request.ts"

import type { Schema } from "@cfworker/json-schema"
import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"

/** MCP revisions that this server answers, newest first. It speaks the stateless JSON subset of Streamable HTTP. */
export const mcpProtocolVersions: readonly string[] = ["2025-11-25", "2025-06-18"]

/** The result of `tools/call`. */
export interface McpToolResult {
  content: Array<{ type: "text", text: string }>
  structuredContent?: Record<string, unknown>
  isError: boolean
}

/** A tool as `tools/list` shows it, with the handler that `tools/call` runs. It has the shape of an okmcp `defineTool()`. */
export interface McpTool extends Pick<ViteHubMcpTool, "name" | "title" | "description" | "annotations"> {
  /** The JSON Schema of the arguments, an object schema. */
  inputSchema: object
  /** The handler checks the input with its own schema, which names the fields to fix, so the JSON Schema check is skipped. */
  checksInput?: boolean
  /** The largest `tools/call` request for this tool, in bytes. Without it, the server limit applies. */
  maxRequestBytes?: number
  /** The OAuth scopes that a call needs. A caller without them does not see the tool. */
  scopes?: readonly string[]
  handler(input: Record<string, unknown>): Promise<McpToolResult>
}

/** What one request may see: the server identity and the tools of the caller. */
export interface McpServer {
  serverInfo: { name: string, title: string, version: string }
  instructions: string
  tools: readonly McpTool[]
  /** The scopes of the caller's access token. Without them, as for a session, no scope check applies. */
  scopes?: readonly string[]
  /** The `WWW-Authenticate` value of a `403` for a call that lacks `scopes`, so the client asks for them. */
  challenge?: (scopes: readonly string[]) => Promise<string>
}

type JsonRpcId = string | number | null

const maximumBodyBytes = 2 * 1_024 * 1_024
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" }
const validators = new WeakMap<object, Validator>()

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function reply(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers })
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers, status })
}

/** The schema errors of `input`, or nothing when it is valid. Each schema compiles once. */
function invalidInput(tool: McpTool, input: Record<string, unknown>): string | undefined {
  let validator = validators.get(tool.inputSchema)
  // SAFETY: The owner of a tool declares its arguments as a JSON Schema.
  if (!validator) validators.set(tool.inputSchema, validator = new Validator(tool.inputSchema as Schema, "2020-12"))
  const validation = validator.validate(input)
  return validation.valid ? undefined : `Invalid arguments for ${tool.name}: ${validation.errors.map(error => error.error).join("; ")}`
}

function missingScopes(server: McpServer, tool: McpTool): string[] {
  const granted = server.scopes
  return granted ? (tool.scopes ?? []).filter(scope => !granted.includes(scope)) : []
}

/**
 * Answer one MCP request: JSON-RPC parsing, revision negotiation, `initialize`, `ping`, `tools/list`, and `tools/call`.
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
    // Count bytes while reading, since a client can leave out or lie about content-length.
    const text = request.body ? await consoleRequestText(request.body, readLimit) : ""
    bytes = new TextEncoder().encode(text).byteLength
    message = record(JSON.parse(text))
  }
  catch (error) {
    if (Reflect.get(Object(error), "statusCode") === 413) return tooLarge(readLimit)
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

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion
      return reply(id, {
        protocolVersion: typeof requested === "string" && mcpProtocolVersions.includes(requested) ? requested : mcpProtocolVersions[0],
        capabilities: { tools: { listChanged: false } },
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
      const invalid = tool.checksInput ? undefined : invalidInput(tool, input)
      // Since 2025-11-25 (SEP-1303), a bad argument is a tool error, so the Agent reads it and calls again.
      if (invalid) return version === "2025-11-25" ? reply(id, { content: [{ type: "text", text: invalid }], isError: true }) : rpcError(id, -32602, invalid)
      return reply(id, await tool.handler(input))
    }
    default:
      return rpcError(id, -32601, `${server.serverInfo.title} has no method ${method}.`)
  }
}
