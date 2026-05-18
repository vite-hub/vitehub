import { Chat } from "chat"
import { isResolvable, resolveRuntimeValue } from "@vitehub/runtime"

import { createAgentMessage } from "../../messages.ts"
import { streamAgent } from "../../index.ts"

import type {
  AgentChatRuntimeContext,
  ChatActionHookInput,
  ChatAgentHookArgs,
  ChatCapabilityOptions,
  ChatDirectMessageHook,
  ChatEventHook,
  ChatEventHooks,
  ChatHistory,
  ChatMessageHook,
  ChatModalSubmitHookInput,
  ChatNewMessageHook,
  ChatReactionHookInput,
  ChatStreamingPlaceholder,
} from "../types.ts"
import type { AgentDefinition, AgentInput, AgentRunInput, AgentRunMetadata, AgentRuntimeConfig, MaybeResolvable } from "../../types.ts"
import type { AgentMessage, AgentMessagePart, AudioPart } from "../../messages.ts"
import type { ActionEvent, Adapter, ChatConfig, Message as ChatSdkMessage, ModalSubmitEvent, ReactionEvent, SentMessage, StateAdapter, Thread } from "chat"

async function resolveValue<T, TContext extends AgentChatRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  return await resolveRuntimeValue(value, context as never)
}

async function resolveAdapters<TRuntimeConfig extends AgentRuntimeConfig>(
  adapters: ChatCapabilityOptions<TRuntimeConfig>["adapters"],
  context: AgentChatRuntimeContext<TRuntimeConfig>,
): Promise<Record<string, Adapter>> {
  if (typeof adapters === "function" || isResolvable(adapters as MaybeResolvable<Record<string, Adapter>, typeof context>)) {
    return await resolveValue(adapters as MaybeResolvable<Record<string, Adapter>, typeof context>, context)
  }

  const resolved: Record<string, Adapter> = {}
  for (const [name, adapter] of Object.entries(adapters)) {
    resolved[name] = await resolveValue(adapter as MaybeResolvable<Adapter, typeof context>, context)
  }
  return resolved
}

function createMessageHook<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hook: ChatMessageHook<TRuntimeConfig>,
) {
  return (thread: unknown, message: unknown, context?: unknown) => hook({
    bot,
    context: context as never,
    message: message as ChatSdkMessage,
    runtimeConfig,
    thread: thread as never,
  })
}

function createDirectMessageHook<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hook: ChatDirectMessageHook<TRuntimeConfig>,
) {
  return (thread: unknown, message: unknown, channel: unknown, context?: unknown) => hook({
    bot,
    channel: channel as never,
    context: context as never,
    message: message as ChatSdkMessage,
    runtimeConfig,
    thread: thread as never,
  })
}

function createEventHook<TEvent, TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hook: ChatEventHook<TEvent, TRuntimeConfig>,
) {
  return (event: TEvent) => hook({ bot, event, runtimeConfig })
}

function registerNewMessageHooks<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatNewMessageHook<TRuntimeConfig> | Array<ChatNewMessageHook<TRuntimeConfig>> | undefined,
) {
  const hooks = input ? Array.isArray(input) ? input : [input] : []
  for (const hook of hooks) {
    bot.onNewMessage(hook.pattern, createMessageHook(bot, runtimeConfig, hook.handler) as never)
  }
}

function registerReactionHooks<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatReactionHookInput<TRuntimeConfig> | undefined,
) {
  if (!input) return
  if (typeof input === "function") {
    bot.onReaction(createEventHook(bot, runtimeConfig, input as ChatEventHook<ReactionEvent, TRuntimeConfig>) as never)
    return
  }
  if ("emoji" in input && "handler" in input) {
    bot.onReaction(input.emoji as never, createEventHook(bot, runtimeConfig, input.handler) as never)
    return
  }
  for (const [emoji, hook] of Object.entries(input)) {
    if (emoji === "$all") {
      bot.onReaction(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ReactionEvent, TRuntimeConfig>) as never)
    }
    else {
      bot.onReaction([emoji] as never, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ReactionEvent, TRuntimeConfig>) as never)
    }
  }
}

function registerActionHooks<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatActionHookInput<TRuntimeConfig> | undefined,
) {
  if (!input) return
  if (typeof input === "function") {
    bot.onAction(createEventHook(bot, runtimeConfig, input as ChatEventHook<ActionEvent, TRuntimeConfig>) as never)
    return
  }
  for (const [actionId, hook] of Object.entries(input)) {
    if (actionId === "$all") bot.onAction(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ActionEvent, TRuntimeConfig>) as never)
    else bot.onAction(actionId, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ActionEvent, TRuntimeConfig>) as never)
  }
}

function registerModalSubmitHooks<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatModalSubmitHookInput<TRuntimeConfig> | undefined,
) {
  if (!input) return
  if (typeof input === "function") {
    bot.onModalSubmit(createEventHook(bot, runtimeConfig, input as ChatEventHook<ModalSubmitEvent, TRuntimeConfig>) as never)
    return
  }
  for (const [callbackId, hook] of Object.entries(input)) {
    if (callbackId === "$all") bot.onModalSubmit(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ModalSubmitEvent, TRuntimeConfig>) as never)
    else bot.onModalSubmit(callbackId, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ModalSubmitEvent, TRuntimeConfig>) as never)
  }
}

function resolveChatHooks<TRuntimeConfig extends AgentRuntimeConfig>(
  options: ChatCapabilityOptions<TRuntimeConfig>,
): ChatEventHooks<TRuntimeConfig> {
  const resolved = { ...(options.hooks || {}) } as Record<string, unknown>
  for (const name of ["onAction", "onDirectMessage", "onModalSubmit", "onNewMention", "onNewMessage", "onReaction", "onSubscribedMessage"] as const) {
    if (options[name] === undefined) continue
    if (resolved[name] !== undefined) throw new Error(`[vitehub:agent] Duplicate chat hook "${name}". Use either chat({ ${name} }) or chat({ hooks: { ${name} } }), not both.`)
    resolved[name] = options[name]
  }
  delete resolved.agent
  return resolved as ChatEventHooks<TRuntimeConfig>
}

function registerChatHooks<TRuntimeConfig extends AgentRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hooks: ChatEventHooks<TRuntimeConfig>,
) {
  if (hooks.onNewMention) bot.onNewMention(createMessageHook(bot, runtimeConfig, hooks.onNewMention) as never)
  if (hooks.onSubscribedMessage) bot.onSubscribedMessage(createMessageHook(bot, runtimeConfig, hooks.onSubscribedMessage) as never)
  if (hooks.onDirectMessage) bot.onDirectMessage(createDirectMessageHook(bot, runtimeConfig, hooks.onDirectMessage) as never)
  registerNewMessageHooks(bot, runtimeConfig, hooks.onNewMessage)
  registerReactionHooks(bot, runtimeConfig, hooks.onReaction)
  registerActionHooks(bot, runtimeConfig, hooks.onAction)
  registerModalSubmitHooks(bot, runtimeConfig, hooks.onModalSubmit)
}

function getEntityId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : undefined
}

function normalizeHistory(history: ChatHistory | undefined): { enabled: boolean, maxMessages: number } {
  if (!history) return { enabled: false, maxMessages: 0 }
  if (history === true) return { enabled: true, maxMessages: 20 }
  return { enabled: true, maxMessages: history.maxMessages || 20 }
}

function sameMessage(left: ChatSdkMessage | undefined, right: ChatSdkMessage): boolean {
  const leftId = getEntityId(left)
  const rightId = getEntityId(right)
  return !!leftId && !!rightId && leftId === rightId
}

async function collectThreadMessages(thread: unknown, message: ChatSdkMessage, maxMessages: number): Promise<ChatSdkMessage[]> {
  if (maxMessages <= 0) return [message]
  const maybeThread = thread as { allMessages?: AsyncIterable<ChatSdkMessage>, recentMessages?: ChatSdkMessage[], refresh?: () => Promise<void> }
  if (typeof maybeThread.refresh === "function") await Promise.resolve(maybeThread.refresh()).catch(() => undefined)
  const messages = Array.isArray(maybeThread.recentMessages) ? [...maybeThread.recentMessages] : []
  if (!messages.length && maybeThread.allMessages) {
    for await (const item of maybeThread.allMessages) {
      messages.push(item)
      if (messages.length > maxMessages) messages.shift()
    }
  }
  if (!messages.length || !sameMessage(messages.at(-1), message)) messages.push(message)
  return messages.slice(-maxMessages)
}

function getChatMessageText(message: ChatSdkMessage): string {
  if (typeof message.text === "string") return message.text
  const markdown = (message as unknown as { markdown?: unknown }).markdown
  return typeof markdown === "string" ? markdown : ""
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function toAudioPart(value: unknown, index: number): AudioPart | undefined {
  if (!value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  const mediaType = firstString(record.mediaType, record.mimeType, record.contentType, record.type)
  if (!mediaType?.startsWith("audio/")) return
  const data = firstString(record.data, record.base64, record.content)
  const url = firstString(record.url, record.href)
  if ((data ? 1 : 0) + (url ? 1 : 0) !== 1) return
  return { ...(data ? { data } : { url: url! }), id: firstString(record.id) || `audio-${index}`, mediaType, type: "audio" }
}

function collectAudioParts(message: ChatSdkMessage): AudioPart[] {
  const record = message as unknown as Record<string, unknown>
  return [
    record.audio,
    record.attachment,
    ...(Array.isArray(record.attachments) ? record.attachments : []),
    ...(Array.isArray(record.files) ? record.files : []),
    ...(Array.isArray(record.parts) ? record.parts : []),
  ].filter(Boolean).map(toAudioPart).filter((part): part is AudioPart => Boolean(part))
}

function getMessageCreatedAt(message: ChatSdkMessage): Date | string | undefined {
  const dateSent = (message as { metadata?: { dateSent?: unknown } }).metadata?.dateSent
  return dateSent instanceof Date || typeof dateSent === "string" ? dateSent : undefined
}

export function toAgentMessages(messages: ChatSdkMessage[]): AgentMessage[] {
  return messages.map((message, index) => {
    const text = getChatMessageText(message)
    const parts: Array<AgentMessagePart | string> = [...(text ? [text] : []), ...collectAudioParts(message)]
    return createAgentMessage({
      createdAt: getMessageCreatedAt(message),
      id: getEntityId(message) || `chat-message-${index}`,
      metadata: { source: "chat" },
      parts,
      role: (message as { author?: { isMe?: boolean } }).author?.isMe ? "assistant" : "user",
    })
  })
}

function createRunId() {
  return globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

async function collectStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ""
  for await (const event of stream) {
    if (typeof event === "string") text += event
    else if (event && typeof event === "object" && "type" in event && (event as { type?: unknown }).type === "text-delta") text += String((event as { text?: unknown }).text || "")
  }
  return text
}

function createDefaultAgentInput(args: ChatAgentHookArgs, platform?: string): AgentRunInput {
  return {
    context: {
      chat: {
        channelId: getEntityId(args.channel),
        messageId: getEntityId(args.message),
        platform,
        runId: args.run.runId,
        source: "chat",
        threadId: getEntityId(args.thread),
      },
    },
    messages: args.history,
    ...(platform === "devtools" ? { timeout: 90_000 } : {}),
  }
}

async function resolvePlaceholder<TRuntimeConfig extends AgentRuntimeConfig>(
  placeholder: ChatStreamingPlaceholder<TRuntimeConfig> | undefined,
  args: ChatAgentHookArgs<TRuntimeConfig>,
): Promise<string | null> {
  if (placeholder === undefined || placeholder === null || typeof placeholder === "string") return placeholder || null
  return await placeholder(args) || null
}

export async function executeChatAgentResponse<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentChatRuntimeContext<TRuntimeConfig>>,
  runtimeContext: AgentChatRuntimeContext<TRuntimeConfig>,
  options: ChatCapabilityOptions<TRuntimeConfig>,
  baseArgs: ChatAgentHookArgs<TRuntimeConfig>,
  input: AgentRunInput,
  placeholder?: SentMessage,
): Promise<void> {
  const hooks = options.hooks?.agent
  try {
    let result = await streamAgent(agent, runtimeContext, input)
    result = await hooks?.afterRun?.({ ...baseArgs, input, result }) ?? result
    if (hooks?.sendResponse) {
      await hooks.sendResponse({ ...baseArgs, input, result })
      return
    }
    if (placeholder) {
      await placeholder.edit(isAsyncIterable(result) ? await collectStreamText(result) as never : result as never)
      return
    }
    await baseArgs.thread.post(result as never)
  }
  catch (error) {
    if (hooks?.error) {
      await hooks.error({ ...baseArgs, error, input })
      return
    }
    throw error
  }
}

export function createAgentDirectMessageHook<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentChatRuntimeContext<TRuntimeConfig>>,
  runtimeContext: AgentChatRuntimeContext<TRuntimeConfig>,
  options: ChatCapabilityOptions<TRuntimeConfig>,
): ChatDirectMessageHook<TRuntimeConfig> {
  return async (args) => {
    const historyOptions = normalizeHistory(options.history)
    const sourceMessages = historyOptions.enabled
      ? await collectThreadMessages(args.thread, args.message, historyOptions.maxMessages)
      : [args.message]
    const history = toAgentMessages(sourceMessages)
    const run = {
      channelId: getEntityId(args.channel),
      messageId: getEntityId(args.message),
      platform: runtimeContext.platform,
      runId: createRunId(),
      threadId: getEntityId(args.thread),
    } satisfies AgentRunMetadata
    const baseArgs = { ...args, history, run }
    const hooks = options.hooks?.agent
    let input: AgentRunInput | undefined
    try {
      input = hooks?.prepareInput ? await hooks.prepareInput(baseArgs) : createDefaultAgentInput(baseArgs, runtimeContext.platform)
      input = await hooks?.beforeRun?.({ ...baseArgs, input }) || input
      const placeholderText = await resolvePlaceholder(options.fallbackStreamingPlaceholderText, baseArgs)
      const placeholder = placeholderText ? await args.thread.post(placeholderText).catch(() => undefined) as SentMessage | undefined : undefined
      await executeChatAgentResponse(agent, { ...runtimeContext, run }, options, baseArgs, input, placeholder)
    }
    catch (error) {
      if (hooks?.error) {
        await hooks.error({ ...baseArgs, error, input })
        return
      }
      throw error
    }
  }
}

export async function createChatBot<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentDefinition<TRuntimeConfig> | AgentInput<AgentChatRuntimeContext<TRuntimeConfig>>,
  options: ChatCapabilityOptions<TRuntimeConfig>,
  context: AgentChatRuntimeContext<TRuntimeConfig>,
  state: StateAdapter,
  name: string,
): Promise<Chat> {
  const adapters = await resolveAdapters(options.adapters, context)
  const {
    adapters: _adapters,
    fallbackStreamingPlaceholderText,
    history: _history,
    hooks: _hooks,
    onAction: _onAction,
    onDirectMessage: _onDirectMessage,
    onModalSubmit: _onModalSubmit,
    onNewMention: _onNewMention,
    onNewMessage: _onNewMessage,
    onReaction: _onReaction,
    onSubscribedMessage: _onSubscribedMessage,
    setup,
    state: _state,
    userName,
    ...chatOptions
  } = options
  const bot = new Chat({
    ...(chatOptions as Omit<ChatConfig, "adapters" | "state">),
    adapters,
    ...(typeof fallbackStreamingPlaceholderText === "string" || fallbackStreamingPlaceholderText === null ? { fallbackStreamingPlaceholderText } : {}),
    state,
    userName: userName || name,
  })
  const hooks = resolveChatHooks(options)
  if (hooks.onDirectMessage) throw new Error("[vitehub:agent] chat() cannot define onDirectMessage and use the default agent direct-message binding at the same time.")
  registerChatHooks(bot, context.runtimeConfig, hooks)
  bot.onDirectMessage(createDirectMessageHook(bot, context.runtimeConfig, createAgentDirectMessageHook(agent as never, context, options)) as never)
  await setup?.(bot, context)
  return bot
}
