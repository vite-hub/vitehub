import { getCloudflareEnv, resolveWaitUntil } from "@vite-hub/internal/runtime/cloudflare-env"
import { defaultRequestBytes, operationAccessAllows, operationCall, operationInputJsonSchema, operationToolName, parseOperationInput, operationSection, toOperationFailure } from "@vite-hub/internal/operations"
import { toEventRequest } from "@vite-hub/internal/runtime/h3-v1-request"
import { getViteHubMcpTools } from "@vite-hub/internal/runtime/mcp-tools"

import { consoleAccessAllows, consoleAccessWrites, consoleRequest, installedConsoleOAuth, readConsoleAccessUser, readConsoleOperationUser, withConsoleAccess } from "./access.ts"
import { consoleMcpReadScope, consoleMcpWriteScope, isBearerRejection, mcpChallenge, resolveConsoleOAuth } from "./bearer.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"
import { assertLoopbackWithoutSignIn, eventRemoteAddress } from "./loopback.ts"
import { serveMcp } from "./mcp-protocol.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { isConsoleDevelopmentRuntime } from "./request.ts"
import { getConsoleSections } from "./sections.ts"

import type { AnyOperation, OperationContext, OperationFailure } from "@vite-hub/internal/operations"
import type { ViteHubMcpTool } from "@vite-hub/internal/runtime/mcp-tools"
import type { H3Event } from "h3"
import type { ConsoleAccess } from "./access.ts"
import type { McpTool, McpToolResult } from "./mcp-protocol.ts"
import type { ConsoleRequestEvent } from "./request.ts"

const serverInfo = { name: "vitehub", title: "ViteHub MCP", version: "1" }

// Each tool says how to use it. This text stays the same for every owner package, so the Console owns no workflow.
const instructions = "ViteHub MCP gives Agents the operations and server primitives of this app, with the Console access of the person who connects. tools/list shows only the tools of the Console sections that this person may use. Tools marked destructive delete or publish: tell the person what you are about to do first. A failed call says what went wrong and how to fix it."

const registeredToolRequestBytes = 256 * 1_024
const inputSchemas = new WeakMap<AnyOperation, Record<string, unknown>>()

interface ToolContext {
  access: ConsoleAccess
  event: H3Event
  request: Request
}

/** A read-only tool needs `vitehub:read`. Every other tool changes state, so it needs `vitehub:write`. */
function scopesFor(readOnly: boolean): string[] {
  return [readOnly ? consoleMcpReadScope : consoleMcpWriteScope]
}

function operationResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], isError: false, ...(value instanceof Object && !Array.isArray(value) ? { structuredContent: { ...value } } : {}) }
}

function toolFailure(error: OperationFailure): McpToolResult {
  const { status: _status, ...fields } = error
  return {
    content: [{ type: "text", text: [`${error.code}: ${error.message}`, ...(error.fix ? [`Fix: ${error.fix}`] : [])].join("\n") }],
    isError: true,
    structuredContent: { error: fields },
  }
}

/** `content.publish` in words, for the short title that clients show. */
function toolTitle(operation: AnyOperation): string {
  const words = operation.name.replace(/[._-]+/g, " ")
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** A tool for each operation that MCP offers and the caller's sections show. The call checks the section again. */
function operationTools(context: ToolContext, registeredNames: ReadonlySet<string>): McpTool[] {
  const { access } = context
  return consoleOperationRegistry().list()
    .filter(operation => operation.mcp !== false
      && !registeredNames.has(operationToolName(operation.name))
      // An operation that reads its section from the input is checked when it runs.
      && (operation.section instanceof Function || operationAccessAllows(access, operation.section, operation.readOnlyWhen ? undefined : operation)))
    .map((operation) => {
      let inputSchema = inputSchemas.get(operation)
      if (!inputSchema) inputSchemas.set(operation, inputSchema = { ...operationInputJsonSchema(operation), type: "object" })
      return {
        name: operationToolName(operation.name),
        title: toolTitle(operation),
        description: operation.description,
        inputSchema,
        annotations: { readOnlyHint: operation.kind === "read", destructiveHint: operation.kind === "destructive", openWorldHint: false },
        checksInput: true,
        maxRequestBytes: operation.maxRequestBytes ?? defaultRequestBytes,
        scopes: scopesFor(operation.kind === "read"),
        async handler(arguments_) {
          try {
            const input = await parseOperationInput(operation, arguments_)
            const section = operationSection(operation, input)
            if (!operationAccessAllows(access, section, operationCall(operation, input))) {
              return toolFailure({ code: "CONSOLE_ACCESS_DENIED", fix: "Ask for access to the section of this tool.", message: `This sign-in does not include the ${JSON.stringify(section)} section.`, status: 403 })
            }
            const user = operation.user === false ? undefined : await readConsoleOperationUser(access)
            const operationContext: OperationContext = {
              access,
              development: isConsoleDevelopmentBuild(),
              request: context.request,
              response: {},
              surface: "mcp",
              // SAFETY: A Console user from the Auth adapter has the id that the operation user needs.
              user: user ? user as OperationContext["user"] : null,
              env: getCloudflareEnv(context.event, { fallback: false }),
              waitUntil: resolveWaitUntil(context.event, { preferHost: true }),
            }
            return operationResult(await (operation.run as (value: unknown, context: OperationContext) => unknown)(input, operationContext))
          }
          catch (error) {
            const failed = toOperationFailure(error)
            // Provider diagnostics can occur in any field, including the message and fix.
            return toolFailure(failed.status >= 500
              ? { code: "OPERATION_FAILED", message: `${operation.name} failed on the server.`, status: failed.status }
              : failed)
          }
        },
      }
    })
}

/** The tools that owner packages register, such as Comments: their section is installed and in the user's Console access. */
function registeredTools({ access, event }: ToolContext, tools: readonly ViteHubMcpTool[]): McpTool[] {
  return tools
    .filter(tool => tool.annotations?.readOnlyHint === true ? consoleAccessAllows(access, tool.section) : consoleAccessWrites(access, tool.section))
    .map(tool => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      maxRequestBytes: registeredToolRequestBytes,
      scopes: scopesFor(tool.annotations?.readOnlyHint === true),
      async handler(input) {
        try {
          const user = await readConsoleAccessUser(access)
          const result = await tool.call(input, { user: user ? { ...user } : null, event })
          return {
            content: [{ type: "text", text: result.text }],
            ...(result.structured ? { structuredContent: result.structured } : {}),
            isError: result.isError === true,
          }
        }
        catch (error) {
          // A Console request error tells the Agent what to change without exposing server failures.
          const status = Number(Reflect.get(Object(error), "statusCode"))
          if (status >= 400 && status < 500 && error instanceof Error) {
            const statusMessage = Reflect.get(error, "statusMessage")
            return { content: [{ type: "text", text: typeof statusMessage === "string" ? statusMessage : error.message }], isError: true }
          }
          console.error(`[vitehub] ViteHub MCP tool ${tool.name} failed:`, error)
          return { content: [{ type: "text", text: `${tool.name} failed on the server.` }], isError: true }
        }
      },
    }))
}

async function oauthState(event: ConsoleRequestEvent) {
  const oauth = installedConsoleOAuth()
  return oauth ? await resolveConsoleOAuth(oauth, event, consoleRequest(event), isConsoleDevelopmentRuntime()) : undefined
}

/**
 * The answer for a request without a valid sign-in: `401` with the location of the protected resource metadata, so an
 * MCP client starts the OAuth flow. Cloudflare Access and a Console without OAuth have no metadata, so the challenge
 * has none. Access rejections other than sign-in keep their own answer.
 */
export async function mcpUnauthorized(event: ConsoleRequestEvent): Promise<Response> {
  return Response.json({
    code: "CONSOLE_SIGN_IN_REQUIRED",
    fix: "Sign in with your MCP client. It starts the OAuth flow from the resource metadata.",
    message: "Sign in to use the MCP endpoint.",
  }, { headers: { "cache-control": "no-store", "www-authenticate": mcpChallenge(await oauthState(event)) }, status: 401 })
}

const guarded = withConsoleAccess(async (event: H3Event, access: ConsoleAccess) => {
  // Nuxt 4's H3 1 events carry Node's request, which `toEventRequest` reads as a web Request.
  const request = toEventRequest(event)
  try {
    assertLoopbackWithoutSignIn(request, new URL(request.url), { access, remoteAddress: eventRemoteAddress(event) })
  }
  catch (error) {
    const { code, fix, message } = toOperationFailure(error)
    return Response.json({ code, ...(fix ? { fix } : {}), message }, { headers: { "cache-control": "no-store" }, status: 403 })
  }
  const context = { access, event, request }
  const installed = getConsoleSections()
  const registered = getViteHubMcpTools().filter(tool => installed.includes(tool.section))
  // Package tools keep their advertised contract when an operation has the same MCP name.
  // Resolve names before access filtering, so a hidden registered tool cannot fall back to a different operation.
  const registeredNames = new Set(registered.map(tool => tool.name))
  return serveMcp(request, {
    serverInfo,
    instructions,
    tools: [...operationTools(context, registeredNames), ...registeredTools(context, registered)],
    ...(access.scopes ? { scopes: access.scopes } : {}),
    challenge: async scopes => mcpChallenge(await oauthState(event), { description: "The access token lacks a scope that this tool needs.", error: "insufficient_scope", scope: scopes.join(" ") }),
  })
}, { anySection: true, user: true })

/**
 * `/_vitehub/mcp`: ViteHub MCP, a stateless Streamable HTTP MCP server. It runs with the Console access of the request,
 * a session or an OAuth access token, and lists the operations and registered tools that the person may use.
 */
// A plain handler also loads when Nuxt 4 resolves h3 to h3 1, which has no defineHandler().
const handler: (event: H3Event) => Promise<Response> = async (event) => {
  const response = await guarded(event)
  if (isBearerRejection(response)) return response
  // A sign-in that is missing is a 401 for the client, even where the Console would redirect a browser.
  if (response.status === 401 || (response.status >= 300 && response.status < 400)) return mcpUnauthorized(event)
  return response
}
export default handler
