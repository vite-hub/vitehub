import type {
  AgentChannelDeliveryEffectIntent,
  AgentChannels,
  AgentChatOptions,
  AgentChatPlatformResolver,
  AgentChannelWebhookRegistrationDefinition,
  AgentInvocationContextStore,
  AgentMessageChannelSettings,
  AgentRunMetadata,
  AgentRuntimeConfig,
} from "../types.ts"
import type { Lock, StateAdapter } from "chat"

export const messageChannelTitleDeliveredContextKey = "channel.delivery.titleDelivered"
export const messageChannelStateContextKey = "chat.channelState"
const messageChannelTitleClaimTtlMs = 5 * 60 * 1000
const messageChannelInstructions = new WeakMap<object, string>()
const messageChannelInvocationInstructions = new WeakMap<AgentInvocationContextStore, string>()
const auxiliaryMessageChannelInstructionContexts = new WeakSet<object>()
const messageChannelTitleEffectIntents = new WeakSet<AgentChannelDeliveryEffectIntent>()
const messageChannelTitleDeliveryPolicies = new WeakMap<AgentChannelDeliveryEffectIntent, "always" | "once-per-thread">()
const messageChannelTitleDeliveryAttempts = new WeakMap<AgentChannelDeliveryEffectIntent, MessageChannelTitleDeliveryAttempt>()

export interface MessageChannelStateBinding {
  keyPrefix: string
  state: StateAdapter
}

interface MessageChannelTitleDeliveryClaim {
  lock: Lock
  markerKey: string
  settled?: boolean
  state: StateAdapter
}

export interface MessageChannelTitleDeliveryAttempt {
  claim?: MessageChannelTitleDeliveryClaim
  deliver: boolean
  error?: unknown
  persist?: boolean
  reason?: "already-delivered" | "pending"
}

export function defineMessageChannelInstructions<
  TChannel extends object,
>(channel: TChannel, instructions: string): TChannel {
  const value = instructions.trim()
  if (!value) {
    throw new TypeError("[vitehub] Internal Channel instructions must be a non-empty string.")
  }
  messageChannelInstructions.set(channel, value)
  return channel
}

export function inheritMessageChannelInstructions<
  TChannel extends object,
>(channel: TChannel, source: object): TChannel {
  const instructions = messageChannelInstructions.get(source)
  if (instructions) messageChannelInstructions.set(channel, instructions)
  return channel
}

export function inspectMessageChannelInstructions(
  channels: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(channels || {}).flatMap(([channelId, channel]) => {
    const instructions = channel && typeof channel === "object"
      ? messageChannelInstructions.get(channel)
      : undefined
    return instructions ? [`Channel "${channelId}" instructions:\n\n${instructions}`] : []
  })
}

export function bindMessageChannelInstructions(
  context: AgentInvocationContextStore,
  channel: object | undefined,
): void {
  const instructions = channel && messageChannelInstructions.get(channel)
  if (instructions) messageChannelInvocationInstructions.set(context, instructions)
}

export function markAuxiliaryMessageChannelInstructionContext<TContext extends object>(
  context: TContext,
): TContext {
  auxiliaryMessageChannelInstructionContexts.add(context)
  return context
}

export function resolveMessageChannelInstructions(
  context: AgentInvocationContextStore,
  adapterContext?: object,
): string | undefined {
  if (adapterContext && auxiliaryMessageChannelInstructionContexts.has(adapterContext)) return undefined
  return messageChannelInvocationInstructions.get(context)
}

export function createMessageChannelTitleEffectIntent(
  title: string,
  channelDelivery: "always" | "once-per-thread" = "once-per-thread",
  attempt?: MessageChannelTitleDeliveryAttempt,
): AgentChannelDeliveryEffectIntent {
  const intent = { kind: "title", payload: { title } }
  messageChannelTitleEffectIntents.add(intent)
  messageChannelTitleDeliveryPolicies.set(intent, channelDelivery)
  if (attempt) messageChannelTitleDeliveryAttempts.set(intent, attempt)
  return intent
}

export function isMessageChannelTitleEffectIntent(intent: AgentChannelDeliveryEffectIntent): boolean {
  return messageChannelTitleEffectIntents.has(intent)
}

export async function prepareMessageChannelTitleDelivery(
  context: AgentInvocationContextStore,
  run: AgentRunMetadata | undefined,
  intent: AgentChannelDeliveryEffectIntent,
): Promise<MessageChannelTitleDeliveryAttempt> {
  const prepared = messageChannelTitleDeliveryAttempts.get(intent)
  if (prepared) return prepared
  if (messageChannelTitleDeliveryPolicies.get(intent) === "always") {
    return { deliver: true }
  }
  return await claimMessageChannelTitleDelivery(context, run)
}

export async function claimMessageChannelTitleDelivery(
  context: AgentInvocationContextStore,
  run: AgentRunMetadata | undefined,
): Promise<MessageChannelTitleDeliveryAttempt> {
  const binding = context.get<MessageChannelStateBinding>(messageChannelStateContextKey)
  if (!binding || !run?.threadId) return { deliver: true }

  const markerKey = `${binding.keyPrefix}channel-title:${run.threadId}:delivered`
  if (await binding.state.get(markerKey) !== null) {
    return { deliver: false, reason: "already-delivered" }
  }

  const lock = await binding.state.acquireLock(`${binding.keyPrefix}channel-title:${run.threadId}:pending`, messageChannelTitleClaimTtlMs)
  if (!lock) return { deliver: false, reason: "pending" }
  let delivered: boolean
  try {
    delivered = await binding.state.get(markerKey) !== null
  }
  catch (error) {
    try {
      await binding.state.releaseLock(lock)
      return { deliver: true, error }
    }
    catch (releaseError) {
      return {
        deliver: true,
        error: new AggregateError([error, releaseError], "Title delivery state check and lock release failed."),
      }
    }
  }
  if (delivered) {
    try {
      await binding.state.releaseLock(lock)
      return { deliver: false, reason: "already-delivered" }
    }
    catch (error) {
      return { deliver: false, error, reason: "already-delivered" }
    }
  }
  return {
    claim: { lock, markerKey, state: binding.state },
    deliver: true,
  }
}

export async function finishMessageChannelTitleDelivery(
  attempt: MessageChannelTitleDeliveryAttempt,
  delivered: boolean,
  final = true,
): Promise<void> {
  if (!attempt.claim) return
  if (attempt.claim.settled) return
  if (!delivered && !final) return
  attempt.claim.settled = true
  try {
    if (delivered && attempt.persist !== false) await attempt.claim.state.set(attempt.claim.markerKey, true)
  }
  finally {
    await attempt.claim.state.releaseLock(attempt.claim.lock)
  }
}

export async function resetMessageChannelTitleDelivery(
  attempt: MessageChannelTitleDeliveryAttempt,
): Promise<void> {
  if (!attempt.claim) return
  attempt.persist = false
  if (attempt.claim.settled) await attempt.claim.state.delete(attempt.claim.markerKey)
}

function withChannelWebhookProvider<TRuntimeConfig extends AgentRuntimeConfig>(
  channelId: string,
  kind: string,
  input: AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[],
): AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> | AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>[] {
  const apply = (
    registration: AgentChannelWebhookRegistrationDefinition<TRuntimeConfig>,
    id?: string,
  ): AgentChannelWebhookRegistrationDefinition<TRuntimeConfig> => ({
    ...registration,
    adapter: registration.adapter || channelId,
    channelId: registration.channelId || channelId,
    ...(registration.id || !id ? {} : { id }),
    provider: registration.provider || kind,
  })
  return Array.isArray(input) ? input.map(registration => apply(registration)) : apply(input, channelId)
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
  const channelIdentities: NonNullable<AgentChatOptions<TRuntimeConfig>["identity"]>[] = []
  const channelMessageOverrides: AgentMessageChannelSettings<TRuntimeConfig>[] = []

  for (const [channelId, channelDefinition] of entries) {
    if (channelDefinition.messages === false) continue
    hasMessageChannel = true
    messageChannelCount += 1
    if (hasMessageOverrides(channelDefinition.messages)) {
      channelMessageOverrides.push(channelDefinition.messages)
    }
    if (channelDefinition.identity) {
      channelIdentities.push(channelDefinition.identity)
    }

    if (channelDefinition.adapter) {
      platforms[channelId] = channelDefinition.adapter
      if (channelDefinition.webhooks !== false) {
        webhooks[channelId] = channelDefinition.webhooks === true || channelDefinition.webhooks === undefined
          ? { adapter: channelId, channelId, id: channelId, provider: channelDefinition.kind }
          : withChannelWebhookProvider(channelId, channelDefinition.kind, channelDefinition.webhooks)
      }
      else {
        webhooks[channelId] = false
      }
    }
    else if (channelDefinition.webhooks) {
      throw new TypeError("[vitehub] Channel webhooks require an adapter-backed Channel. Add adapter or invoke the Agent from an app-owned route.")
    }
  }

  if (!hasMessageChannel) return undefined
  if (channelIdentities.length) {
    if (messageChannelCount > 1) {
      throw new TypeError("[vitehub] Channel-local identity resolvers are only supported when an Agent defines one message-shaped Channel. Move shared identity to defineAgent({ messages: { identity } }) until Channel-scoped chat triggers land.")
    }
    options.identity = channelIdentities[0]
  }
  if (channelMessageOverrides.length) {
    if (messageChannelCount > 1) {
      const unsupportedOverrides = channelMessageOverrides.some(({ commentary: _commentary, filter: _filter, stream: _stream, ...channelMessages }) => Object.keys(channelMessages).length > 0)
      if (unsupportedOverrides) {
        throw new TypeError("[vitehub] Channel-local messages options other than commentary, filter, or stream are only supported when an Agent defines one message-shaped Channel. Move shared settings to defineAgent({ messages }) until Channel-scoped chat triggers land.")
      }
    }
    else {
      Object.assign(options, channelMessageOverrides[0])
    }
  }
  if (Object.keys(platforms).length) {
    options.platforms = platforms
    options.stream ??= false
  }
  if (Object.keys(webhooks).length) options.webhooks = webhooks
  return options
}
