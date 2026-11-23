import type { WorkspaceName } from "@vite-hub/workspace"

import type { AgentCapabilityDefinition, AgentChannels, AgentInput, AgentRuntimeConfig, AgentRuntimeContext } from "../types.ts"

type WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = {
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  channels?: AgentChannels<TRuntimeConfig>
}

type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = {
  __vitehubWorkspaceAgentOptions?: WorkspaceAgentOptions<TRuntimeConfig, Name>
}

export function hasAgentDefinition(value: unknown): value is { capabilities?: AgentCapabilityDefinition[], resolve: (...args: unknown[]) => unknown } {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof value.resolve === "function"
}

export function agentCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentCapabilityDefinition<TRuntimeConfig>[] {
  if (!hasAgentDefinition(agent)) return []
  const workspaceDefinition = agent as Partial<WorkspaceAgentDefinition<TRuntimeConfig>>
  const workspaceOptions = workspaceDefinition.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig> | undefined
  const capabilities = agent.capabilities || workspaceOptions?.capabilities
  return (Array.isArray(capabilities) ? capabilities : []) as AgentCapabilityDefinition<TRuntimeConfig>[]
}

export function agentChannelOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentChannels<TRuntimeConfig> {
  if (!hasAgentDefinition(agent)) return {}
  const workspaceDefinition = agent as Partial<WorkspaceAgentDefinition<TRuntimeConfig>>
  const workspaceOptions = workspaceDefinition.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig> | undefined
  return (agent.channels || workspaceOptions?.channels || {}) as AgentChannels<TRuntimeConfig>
}
