import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { McpIcon, McpPromptMessage, McpPromptResult, McpResourceContents, McpToolAnnotations, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"
import type { H3Event } from "h3"

export type { McpContentBlock, McpIcon, McpPromptMessage, McpPromptResult, McpResourceContents, McpToolAnnotations, McpToolResult } from "@vite-hub/internal/runtime/mcp-server"

declare global {
  namespace ViteHub {
    /** Generated declarations set `hooks` to the type of the default export of `server/mcp.ts`. */
    interface McpRegistry {}
  }
}

/** A Standard Schema that also gives its JSON Schema, such as a Zod 4 object or Valibot's `toStandardJsonSchema()`. */
export type McpToolInput = StandardSchemaV1 & StandardJSONSchemaV1

/** The person and the MCP client of a request that `mcpOAuth()` signed in. */
export interface McpToolCaller {
  /** The Auth user, read again for each request, so a deleted or banned person has no access. */
  user: { id: string, email?: string | null, name?: string | null, image?: string | null, [key: string]: unknown }
  /** The scopes that the person approved. */
  scopes: string[]
  /** The OAuth client id. */
  clientId: string | undefined
  /** The name that the client registered, such as "Claude Code". */
  clientName: string | undefined
}

/**
 * The `caller` of the handlers: what `resolveCaller` of `server/mcp.ts` returns, else the signed-in {@link McpToolCaller}
 * or `undefined`.
 */
export type McpCaller = ViteHub.McpRegistry extends { hooks: McpHooks<infer TCaller> } ? TCaller : McpToolCaller | undefined

/** The second argument of a tool, prompt, or resource handler. */
export interface McpToolContext {
  /** The H3 event of the MCP request. `event.req` is the web `Request`. */
  event: H3Event
  /**
   * The signed-in caller when `mcpOAuth()` protects the server, else `undefined`. With `resolveCaller` in
   * `server/mcp.ts`, it is the value that `resolveCaller` returns.
   */
  caller: McpCaller
}

/** One tool of the app MCP server, the default export of a file in `server/mcp/tools/`. The file name is the tool name. */
export interface McpToolDefinition<TInput extends McpToolInput | undefined = McpToolInput | undefined> {
  /** A short name for people, such as "List drops". */
  title?: string
  /** What the tool does and when an Agent calls it. Agents read it to pick the tool. */
  description: string
  /** The arguments. The server checks them before the handler runs and lists their JSON Schema in `tools/list`. */
  input?: TInput
  annotations?: McpToolAnnotations
  /**
   * Also serve the tool at `mcp.publicRoute`, where anyone may call it without sign-in. There, `caller` is `undefined`.
   */
  public?: boolean
  /**
   * Runs the call. A string becomes one text block. Another value becomes JSON text, and an object is also the
   * `structuredContent`. An object with a `content` array of blocks, such as `{ content: [{ type: "image", ... }] }`, is
   * sent as the MCP tool result.
   */
  handler: (
    input: TInput extends McpToolInput ? StandardSchemaV1.InferOutput<TInput> : Record<string, never>,
    context: McpToolContext,
  ) => unknown
}

/**
 * Define one tool of the app MCP server. Put it in `server/mcp/tools/<name>.ts` as the default export, and turn the
 * server on with `vitehub({ mcp: true })`. It answers at `/mcp`.
 *
 * ```ts [server/mcp/tools/add.ts]
 * import { defineMcpTool } from "vite-hub/mcp"
 * import { z } from "zod"
 *
 * export default defineMcpTool({
 *   description: "Add two numbers.",
 *   input: z.object({ a: z.number(), b: z.number() }),
 *   handler: ({ a, b }) => ({ sum: a + b }),
 * })
 * ```
 *
 * A thrown error with a 4xx `status`, such as H3's `HTTPError`, is a tool error with its message, so the Agent can fix
 * the call. Other errors are logged and the Agent reads only that the tool failed.
 */
export function defineMcpTool<TInput extends McpToolInput | undefined = undefined>(definition: McpToolDefinition<TInput>): McpToolDefinition<TInput> {
  return definition
}

/** One tool call, as `onToolCall` of `server/mcp.ts` sees it after the handler ran. */
export interface McpToolCall<TCaller = McpCaller> {
  /** The tool name. */
  name: string
  /** The arguments after the input schema checked them. */
  input: unknown
  /** The caller that the handler got. `undefined` when `resolveCaller` threw. */
  caller: TCaller | undefined
  /** The H3 event of the MCP request. */
  event: H3Event
  /** How long the handler ran, in milliseconds. */
  durationMs: number
  /** The result that the Agent reads. A failed call has `isError: true`. */
  result: McpToolResult
  /** What the handler or `resolveCaller` threw. Absent when nothing threw. */
  error?: unknown
}

/** The default export of `server/mcp.ts`: functions that the app MCP server calls for each request. */
export interface McpHooks<TCaller = McpToolCaller | undefined> {
  /**
   * Maps the caller of a request to the app's own identity, such as a user row with its team. The server calls it once
   * per request, before the first tool, prompt, or resource handler, and passes its result as `caller`. `caller` here is
   * the signed-in caller of `mcpOAuth()`, else `undefined`. Throw an error with a 4xx `status` to refuse the call with
   * its message.
   */
  resolveCaller?(context: { event: H3Event, caller: McpToolCaller | undefined }): TCaller | Promise<TCaller>
  /** Runs after each tool call whose arguments passed the input schema, such as to log the call. Its errors are logged. */
  onToolCall?(call: McpToolCall<TCaller>): void | Promise<void>
}

/**
 * Define the hooks of the app MCP server. Put them in `server/mcp.ts` as the default export. The type of the value that
 * `resolveCaller` returns becomes the type of `caller` in every handler.
 *
 * ```ts [server/mcp.ts]
 * import { defineMcpHooks } from "vite-hub/mcp"
 *
 * export default defineMcpHooks({
 *   resolveCaller: ({ caller }) => caller && findMember(caller.user.id),
 *   onToolCall: ({ name, durationMs, result }) => console.info(name, durationMs, result.isError),
 * })
 * ```
 */
export function defineMcpHooks<TCaller = McpToolCaller | undefined>(hooks: McpHooks<TCaller>): McpHooks<TCaller> {
  return hooks
}

/** A Standard Schema with a JSON Schema for the arguments of a prompt. Each field is a string. */
export type McpPromptInput = StandardSchemaV1<Record<string, string | undefined>, unknown> & StandardJSONSchemaV1

/** One prompt of the app MCP server, the default export of a file in `server/mcp/prompts/`. The file name is the prompt name. */
export interface McpPromptDefinition<TInput extends McpPromptInput | undefined = McpPromptInput | undefined> {
  /** A short name for people, such as "Address review feedback". */
  title?: string
  /** What the prompt does. Clients show it when people pick a prompt. */
  description?: string
  /**
   * The arguments: an object schema with string fields. `prompts/list` shows each field as an argument, with its
   * description, and the server checks the arguments with the schema before the handler runs.
   */
  input?: TInput
  /** Also serve the prompt at `mcp.publicRoute`, where `caller` is `undefined`. */
  public?: boolean
  /**
   * Makes the messages. A string becomes one user message. An array is the messages. An object with `messages` is the
   * MCP prompt result.
   */
  handler: (
    input: TInput extends McpPromptInput ? StandardSchemaV1.InferOutput<TInput> : Record<string, never>,
    context: McpToolContext,
  ) => string | McpPromptMessage[] | McpPromptResult | Promise<string | McpPromptMessage[] | McpPromptResult>
}

/**
 * Define one prompt of the app MCP server. Put it in `server/mcp/prompts/<name>.ts` as the default export.
 *
 * ```ts [server/mcp/prompts/review.ts]
 * import { defineMcpPrompt } from "vite-hub/mcp"
 * import { z } from "zod"
 *
 * export default defineMcpPrompt({
 *   description: "Review a pull request.",
 *   input: z.object({ number: z.string().describe("The pull request number.") }),
 *   handler: ({ number }) => `Read pull request ${number} and list its bugs.`,
 * })
 * ```
 */
export function defineMcpPrompt<TInput extends McpPromptInput | undefined = undefined>(definition: McpPromptDefinition<TInput>): McpPromptDefinition<TInput> {
  return definition
}

/** A resource that `resources/list` shows for a template resource. */
export interface McpListedResource {
  uri: string
  /** Defaults to the URI. */
  name?: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

/** The second argument of a resource handler. */
export interface McpResourceContext extends McpToolContext {
  /** The values of the `uriTemplate` variables. Empty for a resource with a fixed `uri`. */
  variables: Record<string, string>
}

/** What a resource handler returns: text, bytes, the MCP contents, or `undefined` when no such resource exists. */
export type McpResourceValue = string | Uint8Array | { contents: McpResourceContents[] } | undefined | null

interface McpResourceFields {
  /** A short name for people, such as "Changelog". */
  title?: string
  description?: string
  /** The MIME type of the contents, such as `text/markdown`. */
  mimeType?: string
  /** Also serve the resource at `mcp.publicRoute`, where `caller` is `undefined`. */
  public?: boolean
  /** Reads the resource. A string is text, and a `Uint8Array` is sent as base64 `blob`. */
  handler: (uri: string, context: McpResourceContext) => McpResourceValue | Promise<McpResourceValue>
}

/**
 * One resource of the app MCP server, the default export of a file in `server/mcp/resources/`. The file name is the
 * resource name. Set `uri` for one resource, or `uriTemplate` for a family of resources, such as one per file.
 */
export type McpResourceDefinition = McpResourceFields & (
  | { /** The URI of the resource, such as `docs://changelog`. */ uri: string, uriTemplate?: never, list?: never }
  | {
    uri?: never
    /** An RFC 6570 URI template, such as `skill://{name}/{+path}`. `{name}` matches one path segment, and `{+path}` also matches `/`. */
    uriTemplate: string
    /** The resources of the template that `resources/list` shows. Without it, clients find them through `resources/templates/list`. */
    list?: (context: McpToolContext) => McpListedResource[] | Promise<McpListedResource[]>
  }
)

/**
 * Define one resource of the app MCP server. Put it in `server/mcp/resources/<name>.ts` as the default export.
 *
 * ```ts [server/mcp/resources/changelog.ts]
 * import { defineMcpResource } from "vite-hub/mcp"
 *
 * export default defineMcpResource({
 *   uri: "docs://changelog",
 *   mimeType: "text/markdown",
 *   handler: () => "# Changelog",
 * })
 * ```
 */
export function defineMcpResource<TDefinition extends McpResourceDefinition>(definition: TDefinition): TDefinition {
  return definition
}

/** The `serverInfo` that MCP clients show. An icon `src` or `websiteUrl` that starts with `/` is a path on the request origin. */
export interface McpServerInfoOptions {
  /** Defaults to the app name. */
  name?: string
  /** Defaults to `name`. */
  title?: string
  /** Defaults to `"1"`. */
  version?: string
  description?: string
  websiteUrl?: string
  icons?: McpIcon[]
}

/** Options of `vitehub({ mcp })`. */
export interface McpOptions {
  /** The route of the MCP server. Defaults to `/mcp`. */
  route?: string
  /**
   * Require an OAuth access token from `mcpOAuth()` of `vite-hub/auth/mcp`. Defaults to `true` when the app has `auth`.
   * Set `false` for a public server, or to check callers in each handler.
   */
  auth?: boolean
  /**
   * A second route, such as `/mcp`, that serves only the tools with `public: true`, with no sign-in. MCP clients do not
   * sign in on a route that answers without a token, so the tools that need a person stay on `route`.
   */
  publicRoute?: string
  /** What `initialize` tells the Agent about the server, such as which tool to call first. Defaults to a short generic text. */
  instructions?: string
  /** The name, title, version, description, website, and icons that MCP clients show. */
  serverInfo?: McpServerInfoOptions
}
