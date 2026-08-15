import type {
  AgentCallbackContext,
  AgentChannelDefinition,
  AgentRuntimeConfig,
  MaybePromise,
} from "../types.ts"

export const agentChannelHistoryHeader = "x-vitehub-channel-history"

export interface AgentChannelHistoryDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
> {
  resolveDefaultThreadId?: (
    context: AgentCallbackContext<TRuntimeConfig>,
    channel: AgentChannelDefinition<TRuntimeConfig>,
  ) => MaybePromise<string | undefined>
}

const agentChannelHistoryDefinition = Symbol.for("vitehub.agent.channelHistoryDefinition")

export function withAgentChannelHistoryDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TChannel extends AgentChannelDefinition<TRuntimeConfig> = AgentChannelDefinition<TRuntimeConfig>,
>(channel: TChannel, definition: AgentChannelHistoryDefinition<TRuntimeConfig>): TChannel {
  Object.defineProperty(channel, agentChannelHistoryDefinition, {
    configurable: true,
    enumerable: true,
    value: definition,
  })
  return channel
}

export function getAgentChannelHistoryDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  channel: AgentChannelDefinition<TRuntimeConfig>,
): AgentChannelHistoryDefinition<TRuntimeConfig> | undefined {
  return (
    channel as AgentChannelDefinition<TRuntimeConfig> & {
      [agentChannelHistoryDefinition]?: AgentChannelHistoryDefinition<TRuntimeConfig>
    }
  )[agentChannelHistoryDefinition]
}
