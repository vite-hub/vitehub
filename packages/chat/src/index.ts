import { Chat } from "chat"

import { isChatDefinition } from "./runtime/definition.ts"

import type {
  ChatActionHookInput,
  ChatDefinition,
  ChatDirectMessageHook,
  ChatEventHook,
  ChatEventHooks,
  ChatInput,
  ChatMessageHook,
  ChatModalSubmitHookInput,
  ChatNewMessageHook,
  ChatReactionHookInput,
  ChatRuntimeContext,
  DefineChatOptions,
  MaybeResolvable,
  ResolveChatOptions,
} from "./types.ts"
import type { ActionEvent, Adapter, ChatConfig, Message, ModalSubmitEvent, ReactionEvent, StateAdapter } from "chat"

export type {
  ActionEvent,
  Adapter,
  AdapterInput,
  Channel,
  ChatActionHookInput,
  ChatCloudflareDurableObjectModuleOptions,
  ChatDefinition,
  ChatDirectMessageHook,
  ChatDurableObjectStateResolver,
  ChatEventHook,
  ChatEventHooks,
  ChatHookArgs,
  ChatInput,
  ChatMessageHook,
  ChatModalSubmitHookInput,
  ChatModuleOptions,
  ChatNewMessageHook,
  ChatReactionHookInput,
  ChatRuntimeContext,
  ChatRuntimeName,
  ChatWaitUntil,
  ChatWebhookHandlerOptions,
  ChatWebhookModuleOptions,
  ChatWebhookRegistryHandlerOptions,
  ChatWebhookRuntimeHooks,
  CloudflareDurableObjectStateOptions,
  DefineChatOptions,
  DiscoveredChatDefinition,
  MaybePromise,
  MaybeResolvable,
  Message,
  MessageContext,
  ModalSubmitEvent,
  ReactionEvent,
  Resolvable,
  ResolveChatOptions,
  ResolvedChatModuleOptions,
  StateAdapter,
  Thread,
} from "./types.ts"

let definitionId = 0

function isResolvable<T, TContext extends ChatRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
): value is { resolve: (context: TContext) => T | Promise<T> } {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof value.resolve === "function"
}

async function resolveValue<T, TContext extends ChatRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
  context: TContext,
): Promise<T> {
  if (isResolvable(value)) {
    return await value.resolve(context)
  }

  if (typeof value === "function") {
    return await (value as (context: TContext) => T | Promise<T>)(context)
  }

  return value
}

function isAdapterMap(value: unknown): value is Record<string, Adapter> {
  return typeof value === "object" && value !== null
}

async function resolveAdapters<TRuntimeConfig>(
  adapters: DefineChatOptions<TRuntimeConfig>["adapters"],
  context: ChatRuntimeContext<TRuntimeConfig>,
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

function createMessageHook<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  hook: ChatMessageHook<TRuntimeConfig>,
) {
  return (thread: unknown, message: unknown, context?: unknown) => hook({
    bot,
    context: context as never,
    message: message as Message,
    runtimeConfig,
    thread: thread as never,
  })
}

function createDirectMessageHook<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  hook: ChatDirectMessageHook<TRuntimeConfig>,
) {
  return (thread: unknown, message: unknown, channel: unknown, context?: unknown) => hook({
    bot,
    channel: channel as never,
    context: context as never,
    message: message as Message,
    runtimeConfig,
    thread: thread as never,
  })
}

function createEventHook<TEvent, TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  hook: ChatEventHook<TEvent, TRuntimeConfig>,
) {
  return (event: TEvent) => hook({
    bot,
    event,
    runtimeConfig,
  })
}

function registerNewMessageHooks<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  input: ChatNewMessageHook<TRuntimeConfig> | Array<ChatNewMessageHook<TRuntimeConfig>> | undefined,
) {
  const hooks = input ? Array.isArray(input) ? input : [input] : []
  for (const hook of hooks) {
    bot.onNewMessage(hook.pattern, createMessageHook(bot, runtimeConfig, hook.handler) as never)
  }
}

function registerReactionHooks<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
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

function registerActionHooks<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  input: ChatActionHookInput<TRuntimeConfig> | undefined,
) {
  if (!input) return

  if (typeof input === "function") {
    bot.onAction(createEventHook(bot, runtimeConfig, input as ChatEventHook<ActionEvent, TRuntimeConfig>) as never)
    return
  }

  for (const [actionId, hook] of Object.entries(input)) {
    if (actionId === "$all") {
      bot.onAction(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ActionEvent, TRuntimeConfig>) as never)
    }
    else {
      bot.onAction(actionId, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ActionEvent, TRuntimeConfig>) as never)
    }
  }
}

function registerModalSubmitHooks<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  input: ChatModalSubmitHookInput<TRuntimeConfig> | undefined,
) {
  if (!input) return

  if (typeof input === "function") {
    bot.onModalSubmit(createEventHook(bot, runtimeConfig, input as ChatEventHook<ModalSubmitEvent, TRuntimeConfig>) as never)
    return
  }

  for (const [callbackId, hook] of Object.entries(input)) {
    if (callbackId === "$all") {
      bot.onModalSubmit(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ModalSubmitEvent, TRuntimeConfig>) as never)
    }
    else {
      bot.onModalSubmit(callbackId, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ModalSubmitEvent, TRuntimeConfig>) as never)
    }
  }
}

function registerChatHooks<TRuntimeConfig>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig | undefined,
  hooks: ChatEventHooks<TRuntimeConfig> | undefined,
) {
  if (!hooks) return

  if (hooks.onNewMention) {
    bot.onNewMention(createMessageHook(bot, runtimeConfig, hooks.onNewMention) as never)
  }
  if (hooks.onSubscribedMessage) {
    bot.onSubscribedMessage(createMessageHook(bot, runtimeConfig, hooks.onSubscribedMessage) as never)
  }
  if (hooks.onDirectMessage) {
    bot.onDirectMessage(createDirectMessageHook(bot, runtimeConfig, hooks.onDirectMessage) as never)
  }

  registerNewMessageHooks(bot, runtimeConfig, hooks.onNewMessage)
  registerReactionHooks(bot, runtimeConfig, hooks.onReaction)
  registerActionHooks(bot, runtimeConfig, hooks.onAction)
  registerModalSubmitHooks(bot, runtimeConfig, hooks.onModalSubmit)
}

async function createChat<TRuntimeConfig>(
  options: DefineChatOptions<TRuntimeConfig>,
  context: ChatRuntimeContext<TRuntimeConfig>,
  resolveOptions: ResolveChatOptions = {},
) {
  const adapters = await resolveAdapters(options.adapters, context)
  const state = await resolveValue(options.state, context)
  const {
    adapters: _adapters,
    hooks,
    lifecycleHooks: _lifecycleHooks,
    setup,
    state: _state,
    userName: _userName,
    ...chatOptions
  } = options
  const userName = options.userName || resolveOptions.inferredName
  if (!userName) {
    throw new Error("Missing chat userName. Set userName in defineChat() or place the definition in a discovered chat file such as server/chats/bot.ts.")
  }

  const bot = new Chat({
    ...(chatOptions as Omit<ChatConfig, "adapters" | "state">),
    adapters,
    state: state as StateAdapter,
    userName,
  })

  registerChatHooks(bot, context.runtimeConfig, hooks)
  await setup?.(bot, context)
  return bot
}

export function defineChat<TRuntimeConfig = unknown>(
  options: DefineChatOptions<TRuntimeConfig>,
): ChatDefinition<TRuntimeConfig> {
  const memoKey = `vitehub:chat:${++definitionId}`
  return {
    lifecycleHooks: options.lifecycleHooks,
    resolve(context, resolveOptions) {
      const nameKey = resolveOptions?.inferredName || options.userName || "anonymous"
      return context.memo(`${memoKey}:${nameKey}`, () => createChat(options, context, resolveOptions))
    },
  }
}

export async function resolveChat<TContext extends ChatRuntimeContext>(
  chat: ChatInput<TContext>,
  context: TContext,
  options?: ResolveChatOptions,
): Promise<Chat> {
  if (!isAdapterMap(chat) || !isChatDefinition(chat)) {
    return chat as Chat
  }

  return await chat.resolve(context, options)
}
