import type {
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"
import type { MCPClientConfig as AiSdkMcpClientConfig } from "@ai-sdk/mcp"

export interface McpClient {
  close: () => MaybePromise<void>
  serverInfo?: unknown
  tools: () => MaybePromise<Record<string, unknown>>
}

export interface McpClientConfig extends AiSdkMcpClientConfig {
  initializationOptions?: {
    signal?: AbortSignal
    timeout?: number
  }
  protocolVersionDiscovery?: boolean
}

export type McpServerConfig<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | McpClient
  | McpClientConfig
  | false
  | null
  | undefined
  | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<McpClient | McpClientConfig | false | null | undefined>)

export type McpToolFingerprints = Record<string, string>

export interface McpCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  integrity?: Record<string, McpToolFingerprints>
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
