import { Validator } from "@cfworker/json-schema"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

import { consoleRequestText } from "./request.ts"

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
export interface McpTool extends Pick<ViteHubMcpTool, "name" | "title" | "description" | "inputSchema" | "annotations"> {
  handler(input: Record<string, unknown>): Promise<McpToolResult>
}

/** What one request may see: the server identity and the tools of the caller. */
export interface McpServer {
  serverInfo: { name: string, title: string, version: string }
  instructions: string
  tools: readonly McpTool[]
}

type JsonRpcId = string | number | null

const maximumBodyBytes = 256 * 1_024
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
  if (!validator) validators.set(tool.inputSchema, validator = new Validator(tool.inputSchema, "2020-12"))
  const validation = validator.validate(input)
  return validation.valid ? undefined : `Invalid arguments for ${tool.name}: ${validation.errors.map(error => error.error).join("; ")}`
}

/**
 * Answer one MCP request: JSON-RPC parsing, revision negotiation, `initialize`, `ping`, `tools/list`, and `tools/call`.
 * It holds no session, so every POST carries one message and gets one JSON answer.
 */
export async function serveMcp(request: Request, server: McpServer): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ message: `${server.serverInfo.title} accepts JSON-RPC requests with POST.` }, { headers: { ...headers, allow: "POST" }, status: 405 })
  }
  // Browsers send Origin. A page on another origin must not drive the tools with the person's cookie.
  const origin = request.headers.get("origin")
  if (origin && origin !== forwardedRequestOrigin(request)) return rpcError(null, -32600, `This origin may not call ${server.serverInfo.title}.`, 403)
  let message: Record<string, unknown> | undefined
  try {
    message = record(JSON.parse(request.body ? await consoleRequestText(request.body, maximumBodyBytes) : ""))
  }
  catch {
    return rpcError(null, -32700, "The body is not one JSON-RPC message.", 400)
  }
  const method = message?.method
  if (!message || message.jsonrpc !== "2.0" || typeof method !== "string" || !method) return rpcError(null, -32600, "The body is not one JSON-RPC message.", 400)
  const id = message.id ?? null
  if (id !== null && typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id))) {
    return rpcError(null, -32600, "The request id must be a string, number, or null.", 400)
  }
  const version = request.headers.get("mcp-protocol-version")
  if (method !== "initialize" && version !== null && !mcpProtocolVersions.includes(version)) {
    return rpcError(id, -32600, "Unsupported MCP-Protocol-Version. Initialize with a supported revision.", 400)
  }
  // A notification, such as `notifications/initialized`, gets no answer.
  if (!("id" in message)) return new Response(null, { headers, status: 202 })
  const params = record(message.params) ?? {}

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
        tools: server.tools.map(tool => ({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      })
    case "tools/call": {
      const tool = server.tools.find(candidate => candidate.name === params.name)
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}. Call tools/list for the tools this user may use.`)
      const input = params.arguments === undefined ? {} : record(params.arguments)
      if (!input) return rpcError(id, -32602, `Invalid arguments for ${tool.name}: expected an object.`)
      const invalid = invalidInput(tool, input)
      // Since 2025-11-25 (SEP-1303), a bad argument is a tool error, so the Agent reads it and calls again.
      if (invalid) return version === "2025-11-25" ? reply(id, { content: [{ type: "text", text: invalid }], isError: true }) : rpcError(id, -32602, invalid)
      return reply(id, await tool.handler(input))
    }
    default:
      return rpcError(id, -32601, `${server.serverInfo.title} has no method ${method}.`)
  }
}
