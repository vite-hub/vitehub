import type {
  AgentCallbackContext,
  AgentChannelDefinition,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"

export const agentChannelSyncProviderHeader = "x-vitehub-channel-provider"

export type AgentChannelSyncAction = "create" | "delete" | "none" | "update"

export interface AgentChannelSyncPlan {
  action: AgentChannelSyncAction
  current: Record<string, unknown>
  desired: Record<string, unknown>
  destructive?: boolean
  unverifiable?: string[]
}

export interface AgentChannelSyncProvider {
  apply: (plan: AgentChannelSyncPlan, fetchImpl: typeof fetch) => Promise<Record<string, unknown>>
  plan: (input: {
    desiredUrl?: string
    fetch: typeof fetch
    force: boolean
  }) => Promise<AgentChannelSyncPlan>
  /** Opaque provider resource identity used only to reject conflicting local plans. */
  resourceKey?: unknown
}

export interface AgentChannelSyncDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> {
  mode: "disabled" | "webhook"
  provider: string
  resolve: (context: AgentCallbackContext<TRuntimeConfig>) => MaybePromise<AgentChannelSyncProvider>
}

const agentChannelSyncDefinition = Symbol.for("vitehub.agent.channelSyncDefinition")

export function withAgentChannelSyncDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TChannel extends AgentChannelDefinition<TRuntimeConfig> = AgentChannelDefinition<TRuntimeConfig>,
>(channel: TChannel, definition: AgentChannelSyncDefinition<TRuntimeConfig>): TChannel {
  Object.defineProperty(channel, agentChannelSyncDefinition, {
    configurable: true,
    value: definition,
  })
  return channel
}

export function getAgentChannelSyncDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
): AgentChannelSyncDefinition<TRuntimeConfig> | undefined {
  return (
    channel as AgentChannelDefinition<TRuntimeConfig> & {
      [agentChannelSyncDefinition]?: AgentChannelSyncDefinition<TRuntimeConfig>
    }
  )[agentChannelSyncDefinition]
}
