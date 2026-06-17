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

function hasMessageOverrides<TRuntimeConfig extends AgentRuntimeConfig>(
  messages: false | AgentMessageChannelSettings<TRuntimeConfig> | undefined,
): messages is AgentMessageChannelSettings<TRuntimeConfig> {
  return !!messages && Object.keys(messages).length > 0
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
  let messageChannelCount = 0
  const channelMessageOverrides: AgentMessageChannelSettings<TRuntimeConfig>[] = []

  for (const [channelId, channelDefinition] of entries) {
    if (channelDefinition.messages === false) continue
    hasMessageChannel = true
    messageChannelCount += 1
    if (hasMessageOverrides(channelDefinition.messages)) {
      channelMessageOverrides.push(channelDefinition.messages)
    }

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
  if (channelMessageOverrides.length) {
    if (messageChannelCount > 1) {
      throw new TypeError("[vitehub] Channel-local messages options are only supported when an Agent defines one message-shaped Channel. Move shared settings to defineAgent({ messages }) until Channel-scoped chat triggers land.")
    }
    Object.assign(options, channelMessageOverrides[0])
  }
  if (Object.keys(platforms).length) options.platforms = platforms
  if (Object.keys(webhooks).length) options.webhooks = webhooks
  return options
}
