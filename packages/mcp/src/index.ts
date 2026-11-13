import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import type { McpToolAnnotations } from "@vite-hub/internal/runtime/mcp-server"
import type { H3Event } from "h3"

export type { McpContentBlock, McpToolAnnotations } from "@vite-hub/internal/runtime/mcp-server"

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

/** The second argument of a tool handler. */
export interface McpToolContext {
  /** The H3 event of the MCP request. `event.req` is the web `Request`. */
  event: H3Event
  /** The signed-in caller when `mcpOAuth()` protects the server, else `undefined`. */
  caller: McpToolCaller | undefined
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
   * Set it only with `mcp.publicRoute`. Without one, the server fails with `MCP_R0001`.
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

/** Options of `vitehub({ mcp })`. */
export interface McpOptions {
  /** The route of the MCP server. Defaults to `/mcp`. */
  route?: string
  /**
   * Require an OAuth access token from `mcpOAuth()` of `vite-hub/auth/mcp`. Defaults to `true`, and then the app needs
   * `auth`. Set `false` to let anyone call every tool, or to check callers in each handler.
   */
  auth?: boolean
  /**
   * A second route, such as `/mcp`, that serves only the tools with `public: true`, with no sign-in. MCP clients do not
   * sign in on a route that answers without a token, so the tools that need a person stay on `route`. Needs `auth`.
   */
  publicRoute?: string
}
