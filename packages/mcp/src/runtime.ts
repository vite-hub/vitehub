import { serveMcp } from "@vite-hub/internal/runtime/mcp-server"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { standardJsonSchema } from "@vite-hub/internal/standard-schema"

import { mcpErrorDiagnostics } from "./error-diagnostics.ts"

import type { McpContentBlock, McpTool, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"
import type { H3Event } from "h3"
import type { McpToolCaller, McpToolContext, McpToolDefinition } from "./index.ts"

/** What `verifyMcpRequest()` of `vite-hub/auth/mcp` returns. */
export type McpVerifyResult = readonly [{ code: string, message: string }, undefined] | readonly [undefined, McpToolCaller]

/** Options of {@link createMcpHandler}. The generated server entry passes them. */
export interface McpHandlerOptions {
  /** The route of the server, such as `/mcp`. */
  route: string
  /** The route that serves the tools with `public: true`. Without it, a tool that sets `public` is an error. */
  publicRoute?: string
  /** The name that clients show, such as the app name. */
  name: string
  /** The tools by name, from the files in `server/mcp/tools/`. */
  tools: Record<string, McpToolDefinition>
  /** Checks the access token of a request. Present when `mcpOAuth()` protects the server. */
  verify?: (request: Request) => Promise<McpVerifyResult>
}

const instructions = "This is the MCP server of the app. Each tool says what it does. A failed call says what went wrong."

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isContentBlock(value: unknown): value is McpContentBlock {
  return isRecord(value) && typeof value.type === "string"
}

/** The MCP result of a handler's return value. */
export function toMcpToolResult(value: unknown): McpToolResult {
  if (typeof value === "string") return { content: [{ type: "text", text: value }], isError: false }
  if (isRecord(value) && Array.isArray(value.content) && value.content.every(isContentBlock)) {
    return {
      content: value.content,
      ...(isRecord(value.structuredContent) ? { structuredContent: value.structuredContent } : {}),
      isError: value.isError === true,
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], ...(isRecord(value) ? { structuredContent: value } : {}), isError: false }
}

function toolError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

function failure(name: string, error: unknown): McpToolResult {
  // H3 2 errors carry `status`, H3 1 errors `statusCode`. A 4xx says what the Agent must change.
  const status = Number(Reflect.get(Object(error), "status") ?? Reflect.get(Object(error), "statusCode"))
  if (status >= 400 && status < 500 && error instanceof Error) return toolError(error.message)
  console.error(`[vitehub] MCP tool ${name} failed:`, error)
  return toolError(`${name} failed on the server.`)
}

function issuesText(name: string, issues: ReadonlyArray<{ message: string, path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }>): string {
  const lines = issues.slice(0, 5).map((issue) => {
    const path = (issue.path ?? []).map(segment => String(isRecord(segment) ? segment.key : segment)).join(".")
    return path ? `${path}: ${issue.message}` : issue.message
  })
  return `Invalid arguments for ${name}: ${lines.join("; ")}`
}

/** What `tools/list` shows of a tool. It is the same for every request. */
function listedTool(name: string, definition: McpToolDefinition): Omit<McpTool, "handler"> {
  return {
    name,
    ...(definition.title ? { title: definition.title } : {}),
    description: definition.description,
    inputSchema: { ...(definition.input ? standardJsonSchema(definition.input, "input") : undefined), type: "object" },
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
  }
}

function toMcpTool(listed: Omit<McpTool, "handler">, definition: McpToolDefinition, context: McpToolContext): McpTool {
  const { name } = listed
  let input: unknown
  let validationFailure: { error: unknown } | undefined
  return {
    ...listed,
    async validate(arguments_) {
      input = arguments_
      try {
        if (definition.input) {
          const result = await definition.input["~standard"].validate(arguments_)
          if (result.issues) return issuesText(name, result.issues)
          input = result.value
        }
      }
      catch (error) {
        validationFailure = { error }
      }
    },
    async handler() {
      try {
        if (validationFailure) return failure(name, validationFailure.error)
        // SAFETY: The schema of the definition accepted the input, so it has the type that the handler declares.
        return toMcpToolResult(await (definition.handler as (value: unknown, context: McpToolContext) => unknown)(input, context))
      }
      catch (error) {
        return failure(name, error)
      }
    },
  }
}

/** The `401` that starts the OAuth flow of an MCP client, with the location of the protected resource metadata. */
function unauthorized(request: Request, route: string, error: { code: string, message: string }): Response {
  const metadata = `${forwardedRequestOrigin(request)}/.well-known/oauth-protected-resource${route}`
  const invalid = error.code === "AUTH_MCP_TOKEN_INVALID"
  const challenge = `Bearer resource_metadata="${metadata}"${invalid ? `, error="invalid_token", error_description="${error.message.replace(/["\\\r\n]/g, "'")}"` : ""}`
  return Response.json({
    code: error.code,
    fix: "Sign in with your MCP client. It starts the OAuth flow from the resource metadata.",
    message: error.message,
  }, { headers: { "cache-control": "no-store", "www-authenticate": challenge }, status: 401 })
}

/**
 * The handler of the app MCP server: stateless Streamable HTTP with JSON answers, one tool per file. With `verify`, a
 * request without a valid access token gets a `401` that names the protected resource metadata.
 */
export function createMcpHandler(options: McpHandlerOptions): (event: H3Event) => Promise<Response> {
  if (!options.publicRoute) {
    const named = Object.entries(options.tools).filter(([, definition]) => definition.public !== undefined).map(([name]) => name)
    if (named.length) {
      throw mcpErrorDiagnostics.MCP_R0001({ message: `[vitehub] The MCP tools ${named.map(name => JSON.stringify(name)).join(", ")} set public, but the MCP server at ${JSON.stringify(options.route)} has no publicRoute.` })
    }
  }
  const serverInfo = { name: options.name, title: options.name, version: "1" }
  const tools = Object.entries(options.tools).map(([name, definition]) => ({ definition, listed: listedTool(name, definition) }))
  return async (event) => {
    const request = event.req
    let caller: McpToolCaller | undefined
    if (options.verify) {
      const [error, verified] = await options.verify(request)
      if (error) {
        // Read no body for a rejected request. Some dev proxies drop the connection when a body is left unread.
        await request.body?.cancel().catch(() => undefined)
        return unauthorized(request, options.route, error)
      }
      caller = verified
    }
    const context: McpToolContext = { caller, event }
    return serveMcp(request, { instructions, serverInfo, tools: tools.map(tool => toMcpTool(tool.listed, tool.definition, context)) })
  }
}

/** The middleware that answers the OAuth discovery documents of `mcpOAuth()` at the origin root. */
export function createMcpOAuthDiscoveryHandler(serve: (request: Request) => Promise<Response | undefined>): (event: H3Event) => Promise<Response | undefined> {
  return async (event) => {
    if (!event.url.pathname.startsWith("/.well-known/")) return undefined
    return await serve(event.req)
  }
}
