import { readElicitation, toElicitation } from "@vite-hub/forms"
import { mcpArgumentsInvalid, mcpMethodFailed, mcpMethodRpcCode, serveMcp } from "@vite-hub/internal/runtime/mcp-server"
import { forwardedRequestOrigin } from "@vite-hub/internal/runtime/request-origin"
import { standardJsonSchema } from "@vite-hub/internal/standard-schema"

import { mcpErrorDiagnostics } from "./error-diagnostics.ts"

import type { McpContentBlock, McpPrompt, McpPromptArgument, McpPromptResult, McpResource, McpResourceContents, McpSecurityScheme, McpServerInfo, McpTool, McpToolCallContext, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"
import type { H3Event } from "h3"
import type { McpHooks, McpPromptDefinition, McpResourceDefinition, McpResourceValue, McpServerInfoOptions, McpToolCaller, McpToolContext, McpToolDefinition, McpToolHandlerContext } from "./index.ts"

/** What `verifyMcpRequest()` of `vite-hub/auth/mcp` returns. */
export type McpVerifyResult = readonly [{ code: string, message: string }, undefined] | readonly [undefined, McpToolCaller]

/** Options of {@link createMcpHandler}. The generated server entry passes them. */
export interface McpHandlerOptions {
  /** The route of the server, such as `/mcp`. */
  route: string
  /** The route that serves the tools with `access: "public"`. Without it, a tool that sets `access` is an error. */
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
  /**
   * The Nitro preset of a build whose server instances cannot share a waiting tool call, such as `cloudflare-module`.
   * There, `elicit()` throws `MCP_ELICITATION_HOST_UNSUPPORTED`. `hubMcp()` sets it.
   */
  elicitationUnsupportedHost?: string
  /**
   * With `verify`, serve a request without a token too: it may list every tool and call the tools, prompts, and
   * resources with `access: "public"`. `mcp.auth: "optional"` sets it.
   */
  optional?: boolean
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
      ...(isRecord(value._meta) ? { _meta: value._meta } : {}),
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], ...(isRecord(value) ? { structuredContent: value } : {}), isError: false }
}

function toolError(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

const elicitationCodes = new Set(["MCP_ELICITATION_CLIENT_UNSUPPORTED", "MCP_ELICITATION_HOST_UNSUPPORTED"])

function failure(name: string, error: unknown): McpToolResult {
  if (error instanceof Error && elicitationCodes.has(error.name)) {
    const fix = Reflect.get(error, "fix")
    return toolError(`${error.name}: ${error.message}${typeof fix === "string" ? ` ${fix}` : ""}`)
  }
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

function securitySchemes(definition: McpToolDefinition, optional: boolean): McpSecurityScheme[] {
  const oauth2: McpSecurityScheme = { type: "oauth2", ...(definition.scopes?.length ? { scopes: definition.scopes } : {}) }
  return optional && definition.access === "public" ? [{ type: "noauth" }, oauth2] : [oauth2]
}

function listedTool(name: string, definition: McpToolDefinition, schemes: McpSecurityScheme[] | undefined): Omit<McpTool, "handler"> {
  const meta = schemes ? { ...definition._meta, securitySchemes: schemes } : definition._meta
  return {
    name,
    ...(definition.title ? { title: definition.title } : {}),
    description: definition.description,
    inputSchema: { ...(definition.input ? standardJsonSchema(definition.input, "input") : undefined), type: "object" },
    ...(definition.annotations ? { annotations: definition.annotations } : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(schemes ? { securitySchemes: schemes } : {}),
    ...(definition.scopes?.length ? { scopes: definition.scopes } : {}),
  }
}

interface McpRequestScope {
  event: H3Event
  context: () => Promise<McpToolContext>
  hooks: McpHooks<unknown> | undefined
  elicitationUnsupportedHost: string | undefined
  refuse?: (tool: string, definition: McpToolDefinition) => McpToolResult | undefined
}

function elicitFor(name: string, call: McpToolCallContext, unsupportedHost: string | undefined): McpToolHandlerContext["elicit"] {
  return async (form, { message }) => {
    if (unsupportedHost) throw mcpErrorDiagnostics.MCP_ELICITATION_HOST_UNSUPPORTED({ host: unsupportedHost, tool: name })
    if (!call.canElicit) throw mcpErrorDiagnostics.MCP_ELICITATION_CLIENT_UNSUPPORTED({ tool: name })
    return await readElicitation(form, await call.elicit(toElicitation(form, { message })))
  }
}

async function runTool(name: string, definition: McpToolDefinition, input: unknown, scope: McpRequestScope, call: McpToolCallContext): Promise<{ caller?: unknown, durationMs: number, error?: { value: unknown }, result: McpToolResult }> {
  let caller: unknown
  let started = performance.now()
  try {
    const context: McpToolHandlerContext = { ...await scope.context(), elicit: elicitFor(name, call, scope.elicitationUnsupportedHost) }
    caller = context.caller
    started = performance.now()
    // SAFETY: The schema of the definition accepted the input, so it has the type that the handler declares.
    const result = toMcpToolResult(await (definition.handler as (value: unknown, context: McpToolHandlerContext) => unknown)(input, context))
    return { caller, durationMs: performance.now() - started, result }
  }
  catch (error) {
    return { caller, durationMs: performance.now() - started, error: { value: error }, result: failure(name, error) }
  }
}

function toMcpTool(listed: Omit<McpTool, "handler">, definition: McpToolDefinition, scope: McpRequestScope): McpTool {
  const { name } = listed
  const refused = scope.refuse?.(name, definition)
  if (refused) return { ...listed, handler: async () => refused }
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
    async handler(_input, toolCall) {
      if (validationFailure) return failure(name, validationFailure.error)
      const call = await runTool(name, definition, input, scope, toolCall)
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

function methodFailure(kind: "prompt" | "resource", name: string, error: unknown): unknown {
  if (mcpMethodRpcCode(error) !== undefined) return error
  const status = Number(Reflect.get(Object(error), "status") ?? Reflect.get(Object(error), "statusCode"))
  if (status >= 400 && status < 500 && error instanceof Error) return mcpArgumentsInvalid(error.message, error)
  console.error(`[vitehub] MCP ${kind} ${name} failed:`, error)
  return mcpMethodFailed(name, error)
}

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
          if (result.issues) throw mcpArgumentsInvalid(issuesText(name, result.issues))
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
  const fields = { ...(definition.mimeType ? { mimeType: definition.mimeType } : {}), ...(definition._meta ? { _meta: definition._meta } : {}) }
  if (typeof value === "string") return [{ uri, ...fields, text: value }]
  if (value instanceof Uint8Array) return [{ uri, ...fields, blob: base64(value) }]
  return value.contents
}

function toMcpResource(name: string, definition: McpResourceDefinition, scope: McpRequestScope): McpResource {
  const fields = {
    name,
    ...(definition.title ? { title: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.mimeType ? { mimeType: definition.mimeType } : {}),
    ...(definition._meta ? { _meta: definition._meta } : {}),
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

function resourceMetadata(request: Request, route: string): string {
  return `${forwardedRequestOrigin(request)}/.well-known/oauth-protected-resource${route}`
}

function quoted(value: string): string {
  return value.replace(/["\\\r\n]/g, "'")
}

function scopeChallenge(request: Request, route: string, description: string, scopes: readonly string[]): string {
  return `Bearer resource_metadata="${resourceMetadata(request, route)}", error="insufficient_scope", error_description="${quoted(description)}"${scopes.length ? `, scope="${scopes.join(" ")}"` : ""}`
}

function signInResult(request: Request, route: string, text: string, scopes: readonly string[]): McpToolResult {
  return { content: [{ type: "text", text }], isError: true, _meta: { "mcp/www_authenticate": [scopeChallenge(request, route, text, scopes)] } }
}

function refusal(request: Request, route: string, caller: McpToolCaller | undefined, tool: string, definition: McpToolDefinition): McpToolResult | undefined {
  if (definition.access === "public") return undefined
  const scopes = definition.scopes ?? []
  if (!caller) return signInResult(request, route, `Sign in to call ${tool}. Ask the user to connect their account.`, scopes)
  const missing = scopes.filter(entry => !caller.scopes.includes(entry))
  if (missing.length) return signInResult(request, route, `Sign in again and approve ${missing.join(" ")} to call ${tool}. Ask the user to reconnect their account.`, scopes)
  return undefined
}

function bearerToken(request: Request): string | undefined {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1]
}

function unauthorized(request: Request, route: string, error: { code: string, message: string }): Response {
  const metadata = resourceMetadata(request, route)
  const invalid = error.code === "AUTH_MCP_TOKEN_INVALID"
  const challenge = `Bearer resource_metadata="${metadata}"${invalid ? `, error="invalid_token", error_description="${quoted(error.message)}"` : ""}`
  return Response.json({
    code: error.code,
    fix: "Sign in with your MCP client. It starts the OAuth flow from the resource metadata.",
    message: error.message,
  }, { headers: { "cache-control": "no-store", "www-authenticate": challenge }, status: 401 })
}

/**
 * The handler of the app MCP server: stateless Streamable HTTP with JSON answers, one tool, prompt, or resource per
 * file. With `verify`, a request without a valid access token gets a `401` that names the protected resource metadata.
 * With `optional`, a request without a token is anonymous instead, and only an invalid token gets the `401`.
 */
export function createMcpHandler(options: McpHandlerOptions): (event: H3Event) => Promise<Response> {
  const optional = Boolean(options.verify && options.optional)
  if (!options.publicRoute && !optional) {
    const named = Object.entries(options.tools).filter(([, definition]) => definition.access !== undefined).map(([name]) => name)
    if (named.length) {
      throw mcpErrorDiagnostics.MCP_R0001({ message: `[vitehub] The MCP tools ${named.map(name => JSON.stringify(name)).join(", ")} set access, but the MCP server at ${JSON.stringify(options.route)} has no publicRoute and its auth is not "optional".` })
    }
  }
  const { icons, ...info } = options.serverInfo ?? {}
  const name = info.name ?? options.name
  const serverInfo: McpServerInfo = { ...info, name, title: info.title ?? name, version: info.version ?? "1", ...(icons?.length ? { icons } : {}) }
  const instructions = options.instructions ?? defaultInstructions
  const tools = Object.entries(options.tools).map(([name, definition]) => ({ definition, listed: listedTool(name, definition, options.verify ? securitySchemes(definition, optional) : undefined) }))
  const prompts = Object.entries(options.prompts ?? {}).map(([name, definition]) => ({ definition, listed: listedPrompt(name, definition) }))
  const resources = Object.entries(options.resources ?? {}).map(([name, definition]) => ({ definition, name }))
  return async (event) => {
    const request = event.req
    const hooks = options.hooks
    let caller: McpToolCaller | undefined
    let anonymous = false
    if (options.verify) {
      const [error, verified] = await options.verify(request)
      caller = verified
      anonymous = optional && error?.code === "AUTH_MCP_TOKEN_MISSING"
      if (error && !anonymous) {
        const verifyToken = hooks?.verifyToken
        const token = error.code === "AUTH_MCP_TOKEN_INVALID" && verifyToken ? bearerToken(request) : undefined
        caller = token ? await verifyToken?.({ event, token }) : undefined
        if (!caller) {
          await request.body?.cancel().catch(() => undefined)
          return unauthorized(request, options.route, token ? { code: "AUTH_MCP_TOKEN_INVALID", message: "The token is not an access token of this server, and verifyToken did not accept it." } : error)
        }
      }
    }
    const signedIn = caller
    let context: Promise<McpToolContext> | undefined
    const scope: McpRequestScope = {
      event,
      hooks,
      elicitationUnsupportedHost: options.elicitationUnsupportedHost,
      // SAFETY: `McpCaller` is the type that `resolveCaller` returns, or the signed-in caller without it.
      context: () => context ??= (async () => ({ event, caller: (hooks?.resolveCaller ? await hooks.resolveCaller({ caller, event }) : caller) as McpToolContext["caller"] }))(),
      ...(optional ? { refuse: (tool: string, definition: McpToolDefinition) => refusal(request, options.route, signedIn, tool, definition) } : {}),
    }
    const visible = <T extends { definition: { access?: "public" } }>(entries: T[]) => anonymous ? entries.filter(entry => entry.definition.access === "public") : entries
    return serveMcp(request, {
      instructions,
      serverInfo: resolveServerInfo(serverInfo, request),
      tools: tools.map(tool => toMcpTool(tool.listed, tool.definition, scope)),
      ...(caller ? { principal: JSON.stringify([caller.user.id, caller.clientId]) } : {}),
      prompts: visible(prompts).map(prompt => toMcpPrompt(prompt.listed, prompt.definition, scope)),
      resources: visible(resources).map(({ name, definition }) => toMcpResource(name, definition, scope)),
      ...(caller && !optional ? { scopes: caller.scopes, challenge: async (missing: readonly string[]) => scopeChallenge(request, options.route, `Sign in again and approve ${missing.join(" ")}.`, missing) } : {}),
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
