import type {
  AgentChannelDefinition,
  AgentMessageChannelSettings,
  AgentRuntimeConfig,
} from "./types.ts"

export type {
  AgentChannelDefinition,
  AgentChannels,
  AgentMessageChannelSettings,
} from "./types.ts"

export interface AgentChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig> {
  adapter?: AgentChannelDefinition<TRuntimeConfig>["adapter"]
  identity?: AgentChannelDefinition<TRuntimeConfig>["identity"]
  messages?: false | AgentMessageChannelSettings<TRuntimeConfig>
  webhooks?: AgentChannelDefinition<TRuntimeConfig>["webhooks"]
  [key: string]: unknown
}

export interface AgentHttpChannelOptions<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>
  extends AgentChannelOptions<TRuntimeConfig> {
  path?: string
}

function channel<TRuntimeConfig extends AgentRuntimeConfig>(
  kind: string,
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  const messages: false | AgentMessageChannelSettings<TRuntimeConfig> =
    options.messages === undefined ? {} as AgentMessageChannelSettings<TRuntimeConfig> : options.messages
  return {
    ...options,
    kind,
    messages,
  }
}

export function discord<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return channel("discord", options)
}

export function http<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentHttpChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return channel("http", options)
}

export function slack<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return channel("slack", options)
}

export function teams<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return channel("teams", options)
}

export function webChat<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  options: AgentChannelOptions<TRuntimeConfig> = {},
): AgentChannelDefinition<TRuntimeConfig> {
  return channel("web-chat", options)
}
