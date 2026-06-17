import type {
  AgentChannels,
  AgentChatOptions,
  AgentChatPlatformResolver,
  AgentChatWebhookRegistrationDefinition,
  AgentMessageChannelSettings,
  AgentRuntimeConfig,
} from "../types.ts"

function withChannelWebhookProvider<TRuntimeConfig extends AgentRuntimeConfig>(
  channelId: string,
  kind: string,
  input: AgentChatWebhookRegistrationDefinition<TRuntimeConfig> | AgentChatWebhookRegistrationDefinition<TRuntimeConfig>[],
): AgentChatWebhookRegistrationDefinition<TRuntimeConfig> | AgentChatWebhookRegistrationDefinition<TRuntimeConfig>[] {
  const apply = (registration: AgentChatWebhookRegistrationDefinition<TRuntimeConfig>): AgentChatWebhookRegistrationDefinition<TRuntimeConfig> => ({
    ...registration,
    id: registration.id || channelId,
    provider: registration.provider || kind,
  })
  return Array.isArray(input) ? input.map(apply) : apply(input)
}

export function resolveAgentChannelChatOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  channels: AgentChannels<TRuntimeConfig> | undefined,
  messages: AgentMessageChannelSettings<TRuntimeConfig> | undefined,
): AgentChatOptions<TRuntimeConfig> | undefined {
  const entries = Object.entries(channels || {})
  if (!entries.length) return undefined

  const platforms: Record<string, AgentChatPlatformResolver<TRuntimeConfig>> = {}
  const webhooks: NonNullable<AgentChatOptions<TRuntimeConfig>["webhooks"]> = {}
  const options: AgentChatOptions<TRuntimeConfig> = { ...(messages || {}) }
  let hasMessageChannel = false

  for (const [channelId, channelDefinition] of entries) {
    if (channelDefinition.messages === false) continue
    hasMessageChannel = true

    // ponytail: one chat trigger still has one option bucket; split this when triggers become channel-scoped.
    Object.assign(options, channelDefinition.messages)

    if (channelDefinition.adapter) {
      platforms[channelId] = channelDefinition.adapter
      if (channelDefinition.webhooks !== false) {
        webhooks[channelId] = channelDefinition.webhooks === true || channelDefinition.webhooks === undefined
          ? { id: channelId, provider: channelDefinition.kind }
          : withChannelWebhookProvider(channelId, channelDefinition.kind, channelDefinition.webhooks)
      }
    }
    else if (channelDefinition.webhooks && channelDefinition.webhooks !== true) {
      webhooks[channelId] = withChannelWebhookProvider(channelId, channelDefinition.kind, channelDefinition.webhooks)
    }

    if (channelDefinition.identity) options.identity = channelDefinition.identity
  }

  if (!hasMessageChannel) return undefined
  if (Object.keys(platforms).length) options.platforms = platforms
  if (Object.keys(webhooks).length) options.webhooks = webhooks
  return options
}
