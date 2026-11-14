import { McpMethodError, serveMcp } from "@vite-hub/internal/runtime/mcp-server"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { standardJsonSchema } from "@vite-hub/internal/standard-schema"

import { mcpErrorDiagnostics } from "./error-diagnostics.ts"

import type { McpContentBlock, McpPrompt, McpPromptArgument, McpPromptResult, McpResource, McpResourceContents, McpServerInfo, McpTool, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"
import type { H3Event } from "h3"
import type { McpHooks, McpPromptDefinition, McpResourceDefinition, McpResourceValue, McpServerInfoOptions, McpToolCaller, McpToolContext, McpToolDefinition } from "./index.ts"

/** What `verifyMcpRequest()` of `vite-hub/auth/mcp` returns. */
export type McpVerifyResult = readonly [{ code: string, message: string }, undefined] | readonly [undefined, McpToolCaller]

/** Options of {@link createMcpHandler}. The generated server entry passes them. */
export interface McpHandlerOptions {
  /** The route of the server, such as `/mcp`. */
  route: string
  /** The route that serves the tools with `public: true`. Without it, a tool that sets `public` is an error. */
  publicRoute?: string
  /** The name that clients show, such as the app name. `serverInfo.name` replaces it. */
  name: string
  /** The tools by name, from the files in `server/mcp/tools/`. */
  tools: Record<string, McpToolDefinition>
  /** The prompts by name, from the files in `server/mcp/prompts/`. */
  prompts?: Record<string, McpPromptDefinition>
  /** The resources by name, from the files in `server/mcp/resources/`. */
  resources?: Record<string, McpResourceDefinition>
  /** What `initialize` tells the Agent. */
  instructions?: string
  /** The name, title, version, description, website, and icons that clients show. */
  serverInfo?: McpServerInfoOptions
  /** The default export of `server/mcp.ts`. */
  hooks?: McpHooks<unknown>
  /** Checks the access token of a request. Present when `mcpOAuth()` protects the server. */
  verify?: (request: Request) => Promise<McpVerifyResult>
}

const defaultInstructions = "This is the MCP server of the app. Each tool says what it does. A failed call says what went wrong."

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

/** One request: its event, the context of the handlers, which `resolveCaller` makes once, and the hooks. */
interface McpRequestScope {
  event: H3Event
  context: () => Promise<McpToolContext>
  hooks: McpHooks<unknown> | undefined
}

async function runTool(name: string, definition: McpToolDefinition, input: unknown, scope: McpRequestScope): Promise<{ caller?: unknown, durationMs: number, error?: { value: unknown }, result: McpToolResult }> {
  let caller: unknown
  let started = performance.now()
  try {
    const context = await scope.context()
    caller = context.caller
    started = performance.now()
    // SAFETY: The schema of the definition accepted the input, so it has the type that the handler declares.
    const result = toMcpToolResult(await (definition.handler as (value: unknown, context: McpToolContext) => unknown)(input, context))
    return { caller, durationMs: performance.now() - started, result }
  }
  catch (error) {
    return { caller, durationMs: performance.now() - started, error: { value: error }, result: failure(name, error) }
  }
}

function toMcpTool(listed: Omit<McpTool, "handler">, definition: McpToolDefinition, scope: McpRequestScope): McpTool {
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
      if (validationFailure) return failure(name, validationFailure.error)
      const call = await runTool(name, definition, input, scope)
      if (scope.hooks?.onToolCall) {
        try {
          await scope.hooks.onToolCall({
            name,
            input,
            caller: call.caller,
            event: scope.event,
            durationMs: call.durationMs,
            result: call.result,
            ...(call.error ? { error: call.error.value } : {}),
          })
        }
        catch (error) {
          console.error(`[vitehub] onToolCall failed for MCP tool ${name}:`, error)
        }
      }
      return call.result
    },
  }
}

/** The JSON-RPC error of a prompt or resource handler that threw: its message for a 4xx `status`, else a generic one. */
function methodFailure(kind: "prompt" | "resource", name: string, error: unknown): McpMethodError {
  if (error instanceof McpMethodError) return error
  const status = Number(Reflect.get(Object(error), "status") ?? Reflect.get(Object(error), "statusCode"))
  if (status >= 400 && status < 500 && error instanceof Error) return new McpMethodError(-32602, error.message)
  console.error(`[vitehub] MCP ${kind} ${name} failed:`, error)
  return new McpMethodError(-32603, `${name} failed on the server.`)
}

/** The arguments that `prompts/list` shows: the fields of the input JSON Schema. */
function promptArguments(definition: McpPromptDefinition): McpPromptArgument[] {
  const schema = definition.input ? standardJsonSchema(definition.input, "input") : undefined
  const properties = isRecord(schema?.properties) ? schema.properties : {}
  const required = Array.isArray(schema?.required) ? schema.required : []
  return Object.entries(properties).map(([name, property]) => ({
    name,
    ...(isRecord(property) && typeof property.title === "string" ? { title: property.title } : {}),
    ...(isRecord(property) && typeof property.description === "string" ? { description: property.description } : {}),
    required: required.includes(name),
  }))
}

function toMcpPromptResult(value: unknown): McpPromptResult {
  if (typeof value === "string") return { messages: [{ role: "user", content: { type: "text", text: value } }] }
  // SAFETY: The prompt definition types the handler's return value as messages or a prompt result.
  if (Array.isArray(value)) return { messages: value as McpPromptResult["messages"] }
  return value as McpPromptResult
}

/** What `prompts/list` shows of a prompt. It is the same for every request. */
function listedPrompt(name: string, definition: McpPromptDefinition): Omit<McpPrompt, "get"> {
  const arguments_ = promptArguments(definition)
  return {
    name,
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(arguments_.length ? { arguments: arguments_ } : {}),
  }
}

function toMcpPrompt(listed: Omit<McpPrompt, "get">, definition: McpPromptDefinition, scope: McpRequestScope): McpPrompt {
  const { name } = listed
  return {
    ...listed,
    async get(raw) {
      let input: unknown = raw
      try {
        if (definition.input) {
          const result = await definition.input["~standard"].validate(raw)
          if (result.issues) throw new McpMethodError(-32602, issuesText(name, result.issues))
          input = result.value
        }
        // SAFETY: The schema of the definition accepted the input, so it has the type that the handler declares.
        return toMcpPromptResult(await (definition.handler as (value: unknown, context: McpToolContext) => unknown)(input, await scope.context()))
      }
      catch (error) {
        throw methodFailure("prompt", name, error)
      }
    },
  }
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

function toMcpResourceContents(uri: string, definition: McpResourceDefinition, value: McpResourceValue): McpResourceContents[] | undefined {
  if (value === undefined || value === null) return undefined
  const mimeType = definition.mimeType ? { mimeType: definition.mimeType } : {}
  if (typeof value === "string") return [{ uri, ...mimeType, text: value }]
  if (value instanceof Uint8Array) return [{ uri, ...mimeType, blob: base64(value) }]
  return value.contents
}

function toMcpResource(name: string, definition: McpResourceDefinition, scope: McpRequestScope): McpResource {
  const fields = {
    name,
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
  }
  const list = definition.list
  return {
    ...fields,
    ...(definition.uri === undefined ? { uriTemplate: definition.uriTemplate } : { uri: definition.uri }),
    ...(list
      ? {
          list: async () => {
            try {
              return (await list(await scope.context())).map(resource => ({ ...resource, name: resource.name ?? resource.uri }))
            }
            catch (error) {
              throw methodFailure("resource", name, error)
            }
          },
        }
      : {}),
    async read(uri, variables) {
      try {
        return toMcpResourceContents(uri, definition, await definition.handler(uri, { ...await scope.context(), variables }))
      }
      catch (error) {
        throw methodFailure("resource", name, error)
      }
    },
  }
}

/** The `serverInfo` of a request. An icon `src` or `websiteUrl` that starts with `/` becomes a URL on the request origin. */
function resolveServerInfo(info: McpServerInfo, request: Request): McpServerInfo {
  const relative = (value: string | undefined) => value?.startsWith("/") && !value.startsWith("//")
  if (!relative(info.websiteUrl) && !info.icons?.some(icon => relative(icon.src))) return info
  const origin = forwardedRequestOrigin(request)
  const absolute = (value: string) => relative(value) ? `${origin}${value}` : value
  return {
    ...info,
    ...(info.websiteUrl ? { websiteUrl: absolute(info.websiteUrl) } : {}),
    ...(info.icons ? { icons: info.icons.map(icon => ({ ...icon, src: absolute(icon.src) })) } : {}),
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
 * The handler of the app MCP server: stateless Streamable HTTP with JSON answers, one tool, prompt, or resource per
 * file. With `verify`, a request without a valid access token gets a `401` that names the protected resource metadata.
 */
export function createMcpHandler(options: McpHandlerOptions): (event: H3Event) => Promise<Response> {
  if (!options.publicRoute) {
    const named = Object.entries(options.tools).filter(([, definition]) => definition.public !== undefined).map(([name]) => name)
    if (named.length) {
      throw mcpErrorDiagnostics.MCP_R0001({ message: `[vitehub] The MCP tools ${named.map(name => JSON.stringify(name)).join(", ")} set public, but the MCP server at ${JSON.stringify(options.route)} has no publicRoute.` })
    }
  }
  const { icons, ...info } = options.serverInfo ?? {}
  const name = info.name ?? options.name
  const serverInfo: McpServerInfo = { ...info, name, title: info.title ?? name, version: info.version ?? "1", ...(icons?.length ? { icons } : {}) }
  const instructions = options.instructions ?? defaultInstructions
  const tools = Object.entries(options.tools).map(([name, definition]) => ({ definition, listed: listedTool(name, definition) }))
  const prompts = Object.entries(options.prompts ?? {}).map(([name, definition]) => ({ definition, listed: listedPrompt(name, definition) }))
  const resources = Object.entries(options.resources ?? {})
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
    const hooks = options.hooks
    let context: Promise<McpToolContext> | undefined
    const scope: McpRequestScope = {
      event,
      hooks,
      // `resolveCaller` runs once per request, when the first handler needs the context, so `initialize` reads no app data.
      // SAFETY: `McpCaller` is the type that `resolveCaller` returns, or the signed-in caller without it.
      context: () => context ??= (async () => ({ event, caller: (hooks?.resolveCaller ? await hooks.resolveCaller({ caller, event }) : caller) as McpToolContext["caller"] }))(),
    }
    return serveMcp(request, {
      instructions,
      serverInfo: resolveServerInfo(serverInfo, request),
      tools: tools.map(tool => toMcpTool(tool.listed, tool.definition, scope)),
      prompts: prompts.map(prompt => toMcpPrompt(prompt.listed, prompt.definition, scope)),
      resources: resources.map(([name, definition]) => toMcpResource(name, definition, scope)),
    })
  }
}

/** The middleware that answers the OAuth discovery documents of `mcpOAuth()` at the origin root. */
export function createMcpOAuthDiscoveryHandler(serve: (request: Request) => Promise<Response | undefined>): (event: H3Event) => Promise<Response | undefined> {
  return async (event) => {
    if (!event.url.pathname.startsWith("/.well-known/")) return undefined
    return await serve(event.req)
  }
}
