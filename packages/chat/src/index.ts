import { getAgentFromRegistry, streamAgent } from "@vitehub/agent"
import { Chat, toAiMessages } from "chat"

import { chatDevtoolsAdapterName, observeChatDevtoolsStream } from "./devtools.ts"
import { isChatDefinition } from "./runtime/definition.ts"

import type {
  ChatActionHookInput,
  ChatAgentBinding,
  ChatAgentBindingOptions,
  ChatAgentHookArgs,
  ChatAgentRuntimeContext,
  ChatDefinition,
  ChatDirectMessageHook,
  ChatEventHook,
  ChatEventHooks,
  ChatInput,
  ChatMessageHook,
  ChatModalSubmitHookInput,
  ChatNewMessageHook,
  ChatReactionHookInput,
  ChatRuntimeConfig,
  ChatRuntimeContext,
  ChatWorkflowHandle,
  DefineChatOptions,
  MaybeResolvable,
  ResolvedChatRuntimeContext,
  ResolveChatOptions,
} from "./types.ts"
import type { AgentRunInput } from "@vitehub/agent"
import type { ActionEvent, Adapter, ChatConfig, Message, ModalSubmitEvent, ReactionEvent, StateAdapter } from "chat"

export type {
  ActionEvent,
  Adapter,
  AdapterInput,
  Channel,
  ChatActionHookInput,
  ChatAgentAfterRunArgs,
  ChatAgentBeforeRunArgs,
  ChatAgentBinding,
  ChatAgentBindingOptions,
  ChatAgentErrorArgs,
  ChatAgentEvent,
  ChatAgentHistory,
  ChatAgentHookArgs,
  ChatAgentHooks,
  ChatAgentMetadata,
  ChatAgentRuntimeContext,
  ChatCloudflareDurableObjectModuleOptions,
  ChatDefinition,
  ChatDevModuleOptions,
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
  ChatRuntimeConfig,
  ChatRuntimeContext,
  ChatRuntimeName,
  ChatWaitUntil,
  ChatWebhookHandlerOptions,
  ChatWebhookModuleOptions,
  ChatWebhookRegistryHandlerOptions,
  ChatWebhookRuntimeHooks,
  ChatWorkflowHandle,
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
  ResolvedChatRuntimeContext,
  ResolvedChatModuleOptions,
  StateAdapter,
  Thread,
  WorkflowRunLike,
} from "./types.ts"
export * from "./devtools.ts"

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

async function resolveAdapters<TRuntimeConfig extends ChatRuntimeConfig>(
  adapters: DefineChatOptions<TRuntimeConfig, ChatWorkflowHandle<any, any> | undefined>["adapters"],
  context: ResolvedChatRuntimeContext<TRuntimeConfig>,
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

function createMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hook: ChatMessageHook<TRuntimeConfig, TWorkflow>,
  workflow: TWorkflow,
) {
  return (thread: unknown, message: unknown, context?: unknown) => hook({
    bot,
    context: context as never,
    message: message as Message,
    runtimeConfig,
    thread: wrapDevtoolsThread(thread) as never,
    workflow,
  })
}

function createDirectMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hook: ChatDirectMessageHook<TRuntimeConfig, TWorkflow>,
  workflow: TWorkflow,
) {
  return (thread: unknown, message: unknown, channel: unknown, context?: unknown) => hook({
    bot,
    channel: channel as never,
    context: context as never,
    message: message as Message,
    runtimeConfig,
    thread: wrapDevtoolsThread(thread) as never,
    workflow,
  })
}

function normalizeAgentBinding<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  binding: ChatAgentBinding<TRuntimeConfig, TWorkflow>,
): ChatAgentBindingOptions<TRuntimeConfig, TWorkflow> {
  return typeof binding === "string" ? { name: binding } : binding
}

function normalizeAgentHistory(history: ChatAgentBindingOptions["history"]): { enabled: boolean, maxMessages: number } {
  if (history === false || history === "none") {
    return { enabled: false, maxMessages: 0 }
  }
  if (typeof history === "object" && history) {
    return { enabled: true, maxMessages: history.maxMessages || 20 }
  }
  return { enabled: true, maxMessages: 20 }
}

function getEntityId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : undefined
}

function sameMessage(left: Message | undefined, right: Message): boolean {
  const leftId = getEntityId(left)
  const rightId = getEntityId(right)
  return !!leftId && !!rightId && leftId === rightId
}

async function collectThreadMessages(thread: unknown, message: Message, maxMessages: number): Promise<Message[]> {
  if (maxMessages <= 0) {
    return [message]
  }

  const maybeThread = thread as {
    allMessages?: AsyncIterable<Message>
    recentMessages?: Message[]
    refresh?: () => Promise<void>
  }

  if (typeof maybeThread.refresh === "function") {
    await Promise.resolve(maybeThread.refresh()).catch(() => undefined)
  }

  const messages = Array.isArray(maybeThread.recentMessages)
    ? [...maybeThread.recentMessages]
    : []

  if (!messages.length && maybeThread.allMessages) {
    for await (const item of maybeThread.allMessages) {
      messages.push(item)
      if (messages.length > maxMessages) {
        messages.shift()
      }
    }
  }

  if (!messages.length || !sameMessage(messages.at(-1), message)) {
    messages.push(message)
  }

  return messages.slice(-maxMessages)
}

function createAgentRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig>(
  context: ResolvedChatRuntimeContext<TRuntimeConfig>,
): ChatAgentRuntimeContext<TRuntimeConfig> {
  const runtime = context.runtime === "cloudflare"
    ? "cloudflare-agents"
    : context.runtime === "nitro" || context.runtime === "vercel"
      ? context.runtime
      : "unknown"

  return {
    cloudflare: context.cloudflare,
    event: context.event,
    memo: context.memo,
    request: context.request,
    runtime,
    runtimeConfig: context.runtimeConfig,
    vercel: context.vercel,
    waitUntil: context.waitUntil,
  }
}

function createDefaultAgentInput(args: ChatAgentHookArgs, platform?: string): AgentRunInput {
  return {
    context: {
      chat: {
        channelId: getEntityId(args.channel),
        messageId: getEntityId(args.message),
        platform,
        source: "chat",
        threadId: getEntityId(args.thread),
      },
    },
    messages: args.history,
  }
}

function createAgentDirectMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeContext: ResolvedChatRuntimeContext<TRuntimeConfig>,
  binding: ChatAgentBindingOptions<TRuntimeConfig, TWorkflow>,
  workflow: TWorkflow,
): ChatDirectMessageHook<TRuntimeConfig, TWorkflow> {
  return async ({ channel, context, message, runtimeConfig, thread }) => {
    const historyOptions = normalizeAgentHistory(binding.history)
    const sourceMessages = historyOptions.enabled
      ? await collectThreadMessages(thread, message, historyOptions.maxMessages)
      : [message]
    const history = await toAiMessages(sourceMessages) as NonNullable<AgentRunInput["messages"]>
    const baseArgs = {
      bot,
      channel,
      context,
      history,
      message,
      runtimeConfig,
      thread,
      workflow,
    } satisfies ChatAgentHookArgs<TRuntimeConfig, TWorkflow>

    let input: AgentRunInput | undefined
    try {
      input = binding.hooks?.prepareInput
        ? await binding.hooks.prepareInput(baseArgs)
        : createDefaultAgentInput(baseArgs, runtimeContext.platform)
      input = await binding.hooks?.beforeRun?.({ ...baseArgs, input }) || input
      const agentContext = createAgentRuntimeContext(runtimeContext)
      const agent = await getAgentFromRegistry(binding.name, agentContext)
      let result = await streamAgent(agent, agentContext, input)
      result = await binding.hooks?.afterRun?.({ ...baseArgs, input, result }) ?? result
      await (binding.hooks?.sendResponse
        ? binding.hooks.sendResponse({ ...baseArgs, input, result })
        : thread.post(result as never))
    }
    catch (error) {
      if (binding.hooks?.error) {
        await binding.hooks.error({ ...baseArgs, error, input })
        return
      }
      throw error
    }
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function isDevtoolsThread(thread: unknown): thread is { adapter?: { name?: string }, post: (message: unknown) => unknown, startTyping: (text?: string) => Promise<unknown> } {
  return !!thread
    && typeof thread === "object"
    && "post" in thread
    && typeof (thread as { post?: unknown }).post === "function"
    && "startTyping" in thread
    && typeof (thread as { startTyping?: unknown }).startTyping === "function"
    && (thread as { adapter?: { name?: string } }).adapter?.name === chatDevtoolsAdapterName
}

function wrapDevtoolsThread(thread: unknown): unknown {
  if (!isDevtoolsThread(thread)) {
    return thread
  }

  return new Proxy(thread, {
    get(target, property, receiver) {
      if (property !== "post") {
        return Reflect.get(target, property, receiver)
      }

      return (message: unknown) => {
        const next = isAsyncIterable(message)
          ? observeChatDevtoolsStream(target, message)
          : message
        return target.post(next)
      }
    },
  })
}

function createEventHook<
  TEvent,
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hook: ChatEventHook<TEvent, TRuntimeConfig, TWorkflow>,
  workflow: TWorkflow,
) {
  return (event: TEvent) => hook({
    bot,
    event,
    runtimeConfig,
    workflow,
  })
}

function registerNewMessageHooks<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatNewMessageHook<TRuntimeConfig, TWorkflow> | Array<ChatNewMessageHook<TRuntimeConfig, TWorkflow>> | undefined,
  workflow: TWorkflow,
) {
  const hooks = input ? Array.isArray(input) ? input : [input] : []
  for (const hook of hooks) {
    bot.onNewMessage(hook.pattern, createMessageHook(bot, runtimeConfig, hook.handler, workflow) as never)
  }
}

function registerReactionHooks<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatReactionHookInput<TRuntimeConfig, TWorkflow> | undefined,
  workflow: TWorkflow,
) {
  if (!input) return

  if (typeof input === "function") {
    bot.onReaction(createEventHook(bot, runtimeConfig, input as ChatEventHook<ReactionEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    return
  }

  if ("emoji" in input && "handler" in input) {
    bot.onReaction(input.emoji as never, createEventHook(bot, runtimeConfig, input.handler, workflow) as never)
    return
  }

  for (const [emoji, hook] of Object.entries(input)) {
    if (emoji === "$all") {
      bot.onReaction(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ReactionEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    }
    else {
      bot.onReaction([emoji] as never, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ReactionEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    }
  }
}

function registerActionHooks<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatActionHookInput<TRuntimeConfig, TWorkflow> | undefined,
  workflow: TWorkflow,
) {
  if (!input) return

  if (typeof input === "function") {
    bot.onAction(createEventHook(bot, runtimeConfig, input as ChatEventHook<ActionEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    return
  }

  for (const [actionId, hook] of Object.entries(input)) {
    if (actionId === "$all") {
      bot.onAction(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ActionEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    }
    else {
      bot.onAction(actionId, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ActionEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    }
  }
}

function registerModalSubmitHooks<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  input: ChatModalSubmitHookInput<TRuntimeConfig, TWorkflow> | undefined,
  workflow: TWorkflow,
) {
  if (!input) return

  if (typeof input === "function") {
    bot.onModalSubmit(createEventHook(bot, runtimeConfig, input as ChatEventHook<ModalSubmitEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    return
  }

  for (const [callbackId, hook] of Object.entries(input)) {
    if (callbackId === "$all") {
      bot.onModalSubmit(createEventHook(bot, runtimeConfig, hook as ChatEventHook<ModalSubmitEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    }
    else {
      bot.onModalSubmit(callbackId, createEventHook(bot, runtimeConfig, hook as ChatEventHook<ModalSubmitEvent, TRuntimeConfig, TWorkflow>, workflow) as never)
    }
  }
}

function registerChatHooks<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeConfig: TRuntimeConfig,
  hooks: ChatEventHooks<TRuntimeConfig, TWorkflow> | undefined,
  workflow: TWorkflow,
) {
  if (!hooks) return

  if (hooks.onNewMention) {
    bot.onNewMention(createMessageHook(bot, runtimeConfig, hooks.onNewMention, workflow) as never)
  }
  if (hooks.onSubscribedMessage) {
    bot.onSubscribedMessage(createMessageHook(bot, runtimeConfig, hooks.onSubscribedMessage, workflow) as never)
  }
  if (hooks.onDirectMessage) {
    bot.onDirectMessage(createDirectMessageHook(bot, runtimeConfig, hooks.onDirectMessage, workflow) as never)
  }

  registerNewMessageHooks(bot, runtimeConfig, hooks.onNewMessage, workflow)
  registerReactionHooks(bot, runtimeConfig, hooks.onReaction, workflow)
  registerActionHooks(bot, runtimeConfig, hooks.onAction, workflow)
  registerModalSubmitHooks(bot, runtimeConfig, hooks.onModalSubmit, workflow)
}

function registerAgentBinding<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeContext: ResolvedChatRuntimeContext<TRuntimeConfig>,
  hooks: ChatEventHooks<TRuntimeConfig, TWorkflow>,
  binding: ChatAgentBinding<TRuntimeConfig, TWorkflow> | undefined,
  workflow: TWorkflow,
) {
  if (!binding) return

  const resolved = normalizeAgentBinding(binding)
  const event = resolved.event || "directMessage"
  if (event !== "directMessage") {
    throw new Error(`Unsupported chat agent event "${event}". The v1 agent binding only supports "directMessage".`)
  }
  if (resolved.execution && resolved.execution !== "inline") {
    throw new Error(`Unsupported chat agent execution "${resolved.execution}". The v1 agent binding only supports "inline".`)
  }
  if (hooks.onDirectMessage) {
    throw new Error("Duplicate chat hook \"onDirectMessage\". Use either defineChat({ agent }) or defineChat({ onDirectMessage }), not both.")
  }

  bot.onDirectMessage(createDirectMessageHook(
    bot,
    runtimeContext.runtimeConfig,
    createAgentDirectMessageHook(bot, runtimeContext, resolved, workflow),
    workflow,
  ) as never)
}

const chatHookNames = [
  "onAction",
  "onDirectMessage",
  "onModalSubmit",
  "onNewMention",
  "onNewMessage",
  "onReaction",
  "onSubscribedMessage",
] as const

function resolveChatHooks<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  options: DefineChatOptions<TRuntimeConfig, TWorkflow>,
): ChatEventHooks<TRuntimeConfig, TWorkflow> {
  const resolved = { ...(options.hooks || {}) } as Record<string, unknown>

  for (const name of chatHookNames) {
    const hook = options[name]
    if (hook === undefined) {
      continue
    }
    if (resolved[name] !== undefined) {
      throw new Error(`Duplicate chat hook "${name}". Use either defineChat({ ${name} }) or defineChat({ hooks: { ${name} } }), not both.`)
    }
    resolved[name] = hook
  }

  return resolved as ChatEventHooks<TRuntimeConfig, TWorkflow>
}

async function createChat<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  options: DefineChatOptions<TRuntimeConfig, TWorkflow>,
  context: ChatRuntimeContext<TRuntimeConfig>,
  resolveOptions: ResolveChatOptions = {},
) {
  const runtimeConfig = context.runtimeConfig as TRuntimeConfig
  const resolvedContext = { ...context, runtimeConfig } as ResolvedChatRuntimeContext<TRuntimeConfig>
  const adapters = resolveOptions.adapters || await resolveAdapters(options.adapters, resolvedContext)
  const state = await resolveValue(options.state, context)
  const {
    adapters: _adapters,
    agent: _agent,
    hooks: _hooks,
    lifecycleHooks: _lifecycleHooks,
    onAction: _onAction,
    onDirectMessage: _onDirectMessage,
    onModalSubmit: _onModalSubmit,
    onNewMention: _onNewMention,
    onNewMessage: _onNewMessage,
    onReaction: _onReaction,
    onSubscribedMessage: _onSubscribedMessage,
    setup,
    state: _state,
    userName: _userName,
    workflow,
    ...chatOptions
  } = options
  const userName = options.userName || resolveOptions.inferredName
  if (!userName) {
    throw new Error("Missing chat userName. Set userName in defineChat() or place the definition in a discovered chat file such as server/chat.ts.")
  }

  const bot = new Chat({
    ...(chatOptions as Omit<ChatConfig, "adapters" | "state">),
    adapters,
    state: state as StateAdapter,
    userName,
  })

  const hooks = resolveChatHooks(options)
  registerChatHooks(bot, runtimeConfig, hooks, workflow as TWorkflow)
  registerAgentBinding(bot, resolvedContext, hooks, options.agent, workflow as TWorkflow)
  await setup?.(bot, resolvedContext)
  return bot
}

export function defineChat<
  TRuntimeConfig extends ChatRuntimeConfig = ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined = ChatWorkflowHandle<any, any> | undefined,
>(
  options: DefineChatOptions<TRuntimeConfig, TWorkflow>,
): ChatDefinition<TRuntimeConfig> {
  const memoKey = `vitehub:chat:${++definitionId}`
  return {
    lifecycleHooks: options.lifecycleHooks,
    resolve(context, resolveOptions) {
      if (resolveOptions?.adapters) {
        return createChat(options, context, resolveOptions)
      }
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
  if (!isChatDefinition(chat)) {
    return chat as Chat
  }

  return await (chat as ChatDefinition<any>).resolve(context, options)
}
