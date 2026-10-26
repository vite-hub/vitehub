import { getViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"

import { consoleAccessAllows, readConsoleAccessUser, withConsoleAccess } from "./access.ts"
import { consoleRequestText } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import type { H3Event } from "h3"
import type { ConsoleAccess } from "./access.ts"

/** MCP revisions that this server answers, newest first. It speaks the stateless JSON subset of Streamable HTTP. */
export const viteHubMcpProtocolVersions: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

const maximumBodyBytes = 256 * 1_024
const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" }

// Each tool says how to use it. This text stays the same for every owner package, so the Console owns no workflow.
const instructions = "ViteHub MCP gives Agents the server primitives of this app, with the Console access of the person who connects. tools/list shows only the tools of the Console sections that this person may use. Each tool description says when to use it."

type JsonRpcId = string | number | null

function record(value: unknown): Record<string, unknown> | undefined {
  return value instanceof Object && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined
}

function text(value: unknown): string | undefined {
  return String(value) === value ? value : undefined
}

function idOf(value: unknown): JsonRpcId {
  return text(value) ?? (Number.isFinite(value) ? Number(value) : null)
}

function reply(id: JsonRpcId, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers })
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { headers, status })
}

/** The tools that this Console user may call: their section is installed and in the user's Console access. */
function allowedTools(access: ConsoleAccess): ViteHubMcpTool[] {
  const installed = getConsoleSections()
  return getViteHubMcpTools().filter(tool => installed.includes(tool.section) && consoleAccessAllows(access, tool.section))
}

async function handleMcp(event: H3Event, access: ConsoleAccess): Promise<Response> {
  const request = event.req
  if (request.method !== "POST") {
    return Response.json({ message: "ViteHub MCP accepts JSON-RPC requests with POST." }, { headers: { ...headers, allow: "POST" }, status: 405 })
  }
  // Browsers send Origin. A page on another origin must not drive the tools with the person's Console cookie.
  const origin = request.headers.get("origin")
  if (origin && origin !== forwardedRequestOrigin(request)) return rpcError(null, -32600, "This origin may not call ViteHub MCP.", 403)
  let message: Record<string, unknown> | undefined
  try {
    message = record(JSON.parse(request.body ? await consoleRequestText(request.body, maximumBodyBytes) : ""))
  }
  catch {
    return rpcError(null, -32700, "The body is not one JSON-RPC message.", 400)
  }
  const method = text(message?.method)
  if (!message || message.jsonrpc !== "2.0" || !method) return rpcError(null, -32600, "The body is not one JSON-RPC message.", 400)
  const id = idOf(message.id)
  // A notification, such as `notifications/initialized`, gets no answer.
  if (!("id" in message)) return new Response(null, { headers, status: 202 })
  const params = record(message.params) ?? {}

  switch (method) {
    case "initialize": {
      const requested = text(params.protocolVersion)
      return reply(id, {
        protocolVersion: requested && viteHubMcpProtocolVersions.includes(requested) ? requested : viteHubMcpProtocolVersions[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vitehub", title: "ViteHub MCP", version: "1" },
        instructions,
      })
    }
    case "ping":
      return reply(id, {})
    case "tools/list":
      return reply(id, {
        tools: allowedTools(access).map(tool => ({
          name: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      })
    case "tools/call": {
      const tool = allowedTools(access).find(candidate => candidate.name === params.name)
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name)}. Call tools/list for the tools this user may use.`)
      try {
        const user = await readConsoleAccessUser(access)
        const result = await tool.call(record(params.arguments) ?? {}, { user: user ? { ...user } : null, event })
        return reply(id, {
          content: [{ type: "text", text: result.text }],
          ...(result.structured ? { structuredContent: result.structured } : {}),
          isError: result.isError === true,
        })
      }
      catch (error) {
        console.error(`[vitehub] ViteHub MCP tool ${tool.name} failed:`, error)
        return reply(id, { content: [{ type: "text", text: `${tool.name} failed on the server.` }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `ViteHub MCP has no method ${method}.`)
  }
}

/**
 * `POST /_vitehub/mcp`: ViteHub MCP, a stateless Streamable HTTP MCP server. It runs with the Console access of the
 * request, and lists the tools of the Console sections that the person may use, such as Comments.
 */
const handler: (event: H3Event) => Promise<Response> = withConsoleAccess(handleMcp, { anySection: true, user: true })
export default handler
