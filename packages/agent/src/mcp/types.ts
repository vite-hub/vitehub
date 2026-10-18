import type {
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { JSONSchema7 } from "json-schema"
import type { WorkspaceName } from "@vite-hub/workspace"
import type { MCPClientConfig as AiSdkMcpClientConfig } from "@ai-sdk/mcp"

export interface McpClient {
  close: () => MaybePromise<void>
  serverInfo?: unknown
  tools: () => MaybePromise<Record<string, unknown>>
}

export interface McpClientConfig extends AiSdkMcpClientConfig {
  /**
   * Name of a Connection in `server/connections/`. The Connection sends the `Authorization` header,
   * checks access for each request, and records activity. It replaces `transport.fetch`.
   * Requires an `http` or `sse` transport config without `authProvider`.
   */
  connection?: string
  initializationOptions?: {
    signal?: AbortSignal
    timeout?: number
  }
  protocolVersionDiscovery?: boolean
  /** Expose only these tools, by their name on the server. Default: every tool. */
  tools?: readonly string[]
}

/**
 * An MCP server reached through a Connection. Without `transport.url`, the server is the `mcp`
 * endpoint that the Connection's provider declares, over HTTP. `transport` can still add `headers`.
 */
export interface McpConnectionServerConfig extends Omit<McpClientConfig, "connection" | "transport"> {
  /** Name of a Connection in `server/connections/`. */
  connection: string
  /** Leave the server out, without an unavailable notice, until its Connection is connected. */
  optional?: boolean
  transport?: {
    type?: "http" | "sse"
    url?: string
    headers?: Record<string, string>
  }
}

export type McpServerConfig<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | McpClient
  | McpClientConfig
  | McpConnectionServerConfig
  | false
  | null
  | undefined
  | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<McpClient | McpClientConfig | McpConnectionServerConfig | false | null | undefined>)

export type McpToolFingerprints = Record<string, string>

/** Object JSON Schema accepted for an MCP input override. Standard Schema transforms are not supported. */
export type McpToolInputSchema = JSONSchema7 & { type: "object", "~standard"?: never }

/**
 * Application-owned corrections to a remote MCP tool contract.
 *
 * MCP servers are authoritative for execution, but an application may need to
 * pin a description or schema when a server publishes an incomplete contract.
 * Overrides are applied after discovery and before the tool reaches a Driver.
 */
export interface McpToolOverride {
  description?: string
  /** JSON Schema describes the arguments sent to the remote server unchanged. */
  inputSchema?: McpToolInputSchema
  title?: string
}

/** Tool overrides keyed by configured server name and original MCP tool name. */
export type McpToolOverrides = Record<string, Record<string, McpToolOverride>>

export interface McpCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  integrity?: Record<string, McpToolFingerprints>
  /**
   * Application-owned descriptions and schemas for discovered tools. Use this
   * when an MCP server's advertised contract is incomplete or unstable. The
   * override does not change the arguments sent to the remote server.
   */
  toolOverrides?: McpToolOverrides
  servers: Record<string, McpServerConfig<TRuntimeConfig, Name>>
  /**
   * Append a notice to the final chat reply when a server is unavailable.
   * `true` uses the default text. A function receives the unavailable server names.
   */
  unavailableNotice?: boolean | ((servers: string[]) => string)
}

/** One MCP server that was unavailable during an Invocation. Read the list with `getMcpWarnings(input)`. */
export interface McpAvailabilityWarning {
  phase: "discovery" | "resolve"
  server: string
  statusCode?: number
}
