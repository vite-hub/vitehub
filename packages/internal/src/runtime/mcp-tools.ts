/**
 * The JSON Schema of one argument. A tool lists only these keywords, plus
 * `description` and `title` for the Agent.
 */
export type ViteHubMcpValueSchema = {
  description?: string
  title?: string
  enum?: ReadonlyArray<string | number | boolean | null>
} & (
  | { type?: never }
  | { type: "boolean" }
  | { type: "integer" | "number", minimum?: number, maximum?: number }
  | { type: "string", minLength?: number, maxLength?: number }
  | { type: "array", items?: ViteHubMcpValueSchema }
  | { type: "object", properties?: Record<string, ViteHubMcpValueSchema>, required?: string[], additionalProperties?: boolean }
)

/** A JSON Schema object for the arguments of a tool. */
export interface ViteHubMcpInputSchema {
  type: "object"
  properties: Record<string, ViteHubMcpValueSchema>
  required?: string[]
  additionalProperties?: boolean
}

/** An image that the Agent sees, such as a screenshot attached to a comment. */
export interface ViteHubMcpImage {
  /** The bytes, Base64-encoded. */
  data: string
  /** Such as `image/png`. */
  mimeType: string
}

/**
 * What a tool call returns: text for the Agent, the images that it refers to, and the same data as JSON.
 * `mcpToolResult()` turns it into the MCP result, with one `image` block for each image after the text.
 */
export interface ViteHubMcpToolResult {
  text: string
  images?: ViteHubMcpImage[]
  structured?: Record<string, unknown>
  isError?: boolean
}

/** The checked caller of a tool. */
export interface ViteHubMcpToolContext {
  /** The checked user, with every field, or null for a caller without accounts. */
  user: Record<string, unknown> | null
  /** The request event with its Standard Context, when available, for owners that resolve request identity. */
  event?: { readonly "~standard": { readonly req: Request } }
}

/**
 * One tool for an app's own MCP server, such as a Comments tool of `commentsMcpTools()`. ViteHub MCP offers operations
 * instead. The server lists and runs a tool only for a person whose Console access includes the tool's `section`.
 */
export interface ViteHubMcpTool {
  /** Snake case and prefixed with the owner, such as `comments_list_threads`. */
  name: string
  title?: string
  description: string
  inputSchema: ViteHubMcpInputSchema
  /** Only `readOnlyHint: true` permits a read-only Console grant; other tools require full section access. */
  annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }
  /** The Console section whose access the tool needs, such as `comments`. */
  section: string
  call(input: Record<string, unknown>, context: ViteHubMcpToolContext): Promise<ViteHubMcpToolResult>
}
