import { defaultRequestBytes, operationAccessAllows, operationAccessDenial, operationCall, operationInputJsonSchema, operationToolName, parseOperationInput, operationSection, toOperationFailure } from "@vite-hub/internal/operations"
import { getStandardContext } from "@vite-hub/runtime/h3"
import { serveMcp } from "@vite-hub/internal/runtime/mcp-server"

import { consoleOperationGranted, consoleOperationScope, consoleRequest, installedConsoleOAuth, readConsoleOperationUser, withConsoleAccess } from "./access.ts"
import { isBearerRejection, mcpChallenge, resolveConsoleOAuth } from "./bearer.ts"
import { isConsoleDevelopmentBuild } from "./development.ts"
import { consoleOperationRegistry } from "./operation-contributions.ts"
import { consoleRoute, isConsoleDevelopmentRuntime } from "./request.ts"

import type { AnyOperation, OperationContext, OperationFailure } from "@vite-hub/internal/operations"
import type { McpTool, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"
import type { ConsoleAccess } from "./access.ts"
import type { ConsoleRequestEvent, ConsoleRoute } from "./request.ts"

const serverInfo = { name: "vitehub", title: "ViteHub MCP", version: "1" }

// Each tool says how to use it. This text stays the same for every owner package, so the Console owns no workflow.
const instructions = "ViteHub MCP gives Agents the operations and server primitives of this app, with the Console access of the person who connects. tools/list shows only the tools of the Console sections that this person may use. Tools marked destructive delete or publish: tell the person what you are about to do first. A failed call says what went wrong and how to fix it."

const inputSchemas = new WeakMap<AnyOperation, Record<string, unknown>>()

interface ToolContext {
  access: ConsoleAccess
  event: ConsoleRequestEvent
  request: Request
}



/** The result of a call: the text of the operation's `mcp.format`, else the value as JSON, and the value as structured content. */
function operationResult(operation: AnyOperation, value: unknown): McpToolResult {
  const format = operation.mcp ? operation.mcp.format : undefined
  // SAFETY: The operation produced `value`, so it has the output type that its `format` takes.
  const text = format ? (format as (output: unknown) => string)(value) : JSON.stringify(value ?? null)
  return { content: [{ type: "text", text }], isError: false, ...(value instanceof Object && !Array.isArray(value) ? { structuredContent: { ...value } } : {}) }
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
function operationTools(context: ToolContext): McpTool[] {
  const { access } = context
  return consoleOperationRegistry().list()
    .filter(operation => operation.mcp !== false
      // An operation that reads its section or scope from the input is checked again when it runs. `serveMcp()` checks
      // the scopes, so a call that lacks one gets the `insufficient_scope` challenge.
      && consoleOperationGranted(access, operation))
    .map((operation) => {
      let inputSchema = inputSchemas.get(operation)
      if (!inputSchema) inputSchemas.set(operation, inputSchema = { ...operationInputJsonSchema(operation), type: "object" })
      return {
        name: operationToolName(operation.name),
        title: (operation.mcp ? operation.mcp.title : undefined) ?? toolTitle(operation),
        description: operation.description,
        inputSchema,
        annotations: { readOnlyHint: operation.kind === "read", destructiveHint: operation.kind === "destructive", openWorldHint: false },
        maxRequestBytes: operation.maxRequestBytes ?? defaultRequestBytes,
        scopes: [consoleOperationScope(operation)],
        async handler(arguments_) {
          try {
            const input = await parseOperationInput(operation, arguments_)
            const section = operationSection(operation, input)
            if (!operationAccessAllows(access, section, operationCall(operation, input))) {
              const denial = operationAccessAllows(access, section)
                ? { fix: "Grant the section without \":read\".", message: `This sign-in may only read ${JSON.stringify(section)}, and ${operation.name} is a ${operation.kind} operation.` }
                : operationAccessDenial(operation.name, section)
              return toolFailure({ code: "CONSOLE_ACCESS_DENIED", ...denial, status: 403 })
            }
            const user = operation.user === false ? undefined : await readConsoleOperationUser(access)
            const standard = getStandardContext(context.event)
            const operationContext: OperationContext = {
              access,
              development: isConsoleDevelopmentBuild(),
              request: context.request,
              ...(context.event ? { event: context.event } : {}),
              response: {},
              surface: "mcp",
              // SAFETY: A Console user from the Auth adapter has the id that the operation user needs.
              user: user ? user as OperationContext["user"] : null,
              env: standard.runtime?.cloudflare?.env,
              waitUntil: standard.waitUntil,
            }
            return operationResult(operation, await (operation.run as (value: unknown, context: OperationContext) => unknown)(input, operationContext))
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

const guarded = withConsoleAccess(async (event: ConsoleRequestEvent, access: ConsoleAccess) => {
  const request = getStandardContext(event).req
  return serveMcp(request, {
    serverInfo,
    instructions,
    tools: operationTools({ access, event, request }),
    ...(access.scopes ? { scopes: access.scopes } : {}),
    challenge: async scopes => mcpChallenge(await oauthState(event), { description: "The access token lacks a scope that this tool needs.", error: "insufficient_scope", scope: scopes.join(" ") }),
  })
}, { anySection: true, user: true })

/**
 * `/_vitehub/mcp`: ViteHub MCP, a stateless Streamable HTTP MCP server. It runs with the Console access of the request,
 * a session or an OAuth access token, and lists the operations that the person may use.
 */
const consoleMcpRoute: ConsoleRoute = consoleRoute(async (event) => {
  const response = await guarded(event)
  if (isBearerRejection(response)) return response
  // A sign-in that is missing is a 401 for the client, even where the Console would redirect a browser.
  if (response.status === 401 || (response.status >= 300 && response.status < 400)) return mcpUnauthorized(event)
  return response
})
export default consoleMcpRoute
