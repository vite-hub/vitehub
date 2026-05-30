import type {
  AgentAdapterInstructionsValue,
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
  transport: unknown
}

export type McpServerConfig<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> =
  | McpClient
  | McpClientConfig
  | ((context: AgentCapabilityRuntimeContext<TRuntimeConfig, Name>) => MaybePromise<McpClient | McpClientConfig>)

export interface McpCapabilityOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> {
  instructions?: AgentAdapterInstructionsValue | false
  servers: Record<string, McpServerConfig<TRuntimeConfig, Name>>
}
