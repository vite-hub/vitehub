import type {
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

export interface McpClient {
  close: () => MaybePromise<void>
  serverInfo?: unknown
  tools: () => MaybePromise<Record<string, unknown>>
}

export interface McpClientConfig {
  initializationOptions?: {
    maxTotalTimeout?: number
    protocolVersionDiscovery?: boolean
    signal?: AbortSignal
    timeout?: number
  }
  transport: unknown
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
}
