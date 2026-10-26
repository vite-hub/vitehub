/** A JSON Schema object for the arguments of a tool. */
export interface ViteHubMcpInputSchema {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties?: boolean
}

/** What a tool call returns: text for the Agent, and the same data as JSON. */
export interface ViteHubMcpToolResult {
  text: string
  structured?: Record<string, unknown>
  isError?: boolean
}

/** The checked caller of a tool. */
export interface ViteHubMcpToolContext {
  /** The Console user of the request, with every field, or null for a Console without accounts. */
  user: Record<string, unknown> | null
  /** The request event, for owners that read more from it. */
  event: unknown
}

/**
 * One tool of the ViteHub MCP server at `/_vitehub/mcp`. An owner package registers its tools when the server starts.
 * The server lists and runs a tool only for a person whose Console access includes the tool's `section`.
 */
export interface ViteHubMcpTool {
  /** Snake case and prefixed with the owner, such as `comments_list_threads`. */
  name: string
  title?: string
  description: string
  inputSchema: ViteHubMcpInputSchema
  annotations?: { readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }
  /** The Console section whose access the tool needs, such as `comments`. */
  section: string
  call(input: Record<string, unknown>, context: ViteHubMcpToolContext): Promise<ViteHubMcpToolResult>
}

const registryKey: unique symbol = Symbol.for("vitehub.mcp.tools")
// SAFETY: This module owns the process slot that separately bundled owner plugins and the MCP route share.
const scope = globalThis as typeof globalThis & { [registryKey]?: Map<string, readonly ViteHubMcpTool[]> }

/** Registers the tools of one owner, such as `comments`. A second call replaces them, as in development reloads. */
export function registerViteHubMcpTools(owner: string, tools: readonly ViteHubMcpTool[]): void {
  const registry = scope[registryKey] ??= new Map()
  registry.set(owner, tools)
}

/** Every registered tool, in owner registration order. */
export function getViteHubMcpTools(): ViteHubMcpTool[] {
  return [...scope[registryKey]?.values() ?? []].flat()
}
