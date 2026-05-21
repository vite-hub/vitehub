import { getAgentFromRegistry, streamAgent } from "../index.ts"
import { createMessage } from "../messages.ts"
import { chatDevtoolsAdapterName, createChatDevtoolsStepReporter } from "./devtools.ts"

import type {
  ChatAgentBindingOptions,
  ChatAgentHookArgs,
  ChatAgentRuntimeContext,
  ChatDirectMessageHook,
  ChatRuntimeConfig,
  ChatStreamingPlaceholder,
  ChatWorkflowHandle,
  ResolvedChatRuntimeContext,
} from "./types.ts"
import type { AgentRunInput, AgentRunMetadata } from "../index.ts"
import type { Chat, Message as ChatSdkMessage, SentMessage, Thread } from "chat"
import type { Message } from "../messages.ts"

export interface ChatAgentWorkflowPayload {
  agentName: string
  channelId?: string
  cloudflare?: ResolvedChatRuntimeContext["cloudflare"]
  dev?: boolean
  history: Message[]
  input: AgentRunInput
  message: ChatSdkMessage
  placeholder?: ChatSdkMessage
  run: AgentRunMetadata
  threadId?: string
}

function normalizeAgentHistory(history: ChatAgentBindingOptions["history"]): { enabled: boolean, maxMessages: number } {
  if (history === false || history === "none") {
    return { enabled: false, maxMessages: 0 }
  }
  if (typeof history === "object" && history) {
    return { enabled: true, maxMessages: history.maxMessages ?? 20 }
  }
  return { enabled: true, maxMessages: 20 }
}

function getEntityId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : undefined
}

function sameMessage(left: ChatSdkMessage | undefined, right: ChatSdkMessage): boolean {
  const leftId = getEntityId(left)
  const rightId = getEntityId(right)
  return !!leftId && !!rightId && leftId === rightId
}

async function collectThreadMessages(thread: unknown, message: ChatSdkMessage, maxMessages: number): Promise<ChatSdkMessage[]> {
  if (maxMessages <= 0) {
    return [message]
  }

  const maybeThread = thread as {
    allMessages?: AsyncIterable<ChatSdkMessage>
    recentMessages?: ChatSdkMessage[]
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

function getMessageText(message: ChatSdkMessage): string {
  if (typeof message.text === "string") {
    return message.text
  }
  const markdown = (message as unknown as { markdown?: unknown }).markdown
  if (typeof markdown === "string") {
    return markdown
  }
  return ""
}

function getMessageCreatedAt(message: ChatSdkMessage): Date | string | undefined {
  const dateSent = (message as { metadata?: { dateSent?: unknown } }).metadata?.dateSent
  return dateSent instanceof Date || typeof dateSent === "string" ? dateSent : undefined
}

function toChatMessageSnapshot(message: ChatSdkMessage): ChatSdkMessage {
  return {
    id: getEntityId(message),
    metadata: {
      dateSent: getMessageCreatedAt(message),
    },
    text: getMessageText(message),
  } as ChatSdkMessage
}

export function toViteHubMessages(messages: ChatSdkMessage[]): Message[] {
  return messages.map((message, index) => createMessage({
    createdAt: getMessageCreatedAt(message),
    id: getEntityId(message) || `chat-message-${index}`,
    metadata: { source: "chat" },
    role: (message as { author?: { isMe?: boolean } }).author?.isMe ? "assistant" : "user",
    text: getMessageText(message),
  }))
}

function createAgentRuntimeContext<TRuntimeConfig extends ChatRuntimeConfig>(
  context: ResolvedChatRuntimeContext<TRuntimeConfig>,
  thread?: Thread,
  run?: AgentRunMetadata,
): ChatAgentRuntimeContext<TRuntimeConfig> {
  const runtime = context.runtime === "cloudflare"
    ? "cloudflare-agents"
    : context.runtime === "nitro" || context.runtime === "vercel"
      ? context.runtime
      : "unknown"

  const agentContext: ChatAgentRuntimeContext<TRuntimeConfig> = {
    capabilities: context.capabilities,
    cloudflare: context.cloudflare,
    event: context.event,
    memo: context.memo,
    request: context.request,
    run,
    runtime,
    runtimeConfig: context.runtimeConfig,
    vercel: context.vercel,
    waitUntil: context.waitUntil,
  }

  if (isDevtoolsThread(thread)) {
    agentContext.devtools = {
      reportToolStep: createChatDevtoolsStepReporter(thread),
    }
  }

  return agentContext
}

function createRunId() {
  return globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

async function resolvePlaceholder<TRuntimeConfig extends ChatRuntimeConfig>(
  placeholder: ChatStreamingPlaceholder<TRuntimeConfig> | undefined,
  args: ChatAgentHookArgs<TRuntimeConfig>,
): Promise<string | null> {
  if (placeholder === undefined) {
    return null
  }
  if (placeholder === null || typeof placeholder === "string") {
    return placeholder
  }
  if (typeof placeholder === "function") {
    return await placeholder(args) || null
  }
  return null
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value
    && typeof value === "object"
    && Symbol.asyncIterator in value
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
}

function isDevtoolsThread(thread: unknown): thread is Thread & { adapter?: { name?: string }, startTyping: (text?: string) => Promise<unknown> } {
  return !!thread
    && typeof thread === "object"
    && "startTyping" in thread
    && typeof (thread as { startTyping?: unknown }).startTyping === "function"
    && (thread as { adapter?: { name?: string } }).adapter?.name === chatDevtoolsAdapterName
}

async function collectStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ""
  for await (const event of stream) {
    if (typeof event === "string") {
      text += event
      continue
    }
    if (event && typeof event === "object" && "type" in event && (event as { type?: unknown }).type === "text-delta") {
      text += String((event as { text?: unknown }).text || "")
    }
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
        runId: "run" in args && typeof args.run === "object" && args.run ? args.run.runId : undefined,
        source: "chat",
        threadId: getEntityId(args.thread),
      },
    },
    messages: args.history,
    ...(platform === "devtools" ? { timeout: 90_000 } : {}),
  }
}

export async function executeChatAgentResponse<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  runtimeContext: ResolvedChatRuntimeContext<TRuntimeConfig>,
  binding: ChatAgentBindingOptions<TRuntimeConfig, TWorkflow>,
  baseArgs: ChatAgentHookArgs<TRuntimeConfig, TWorkflow>,
  input: AgentRunInput,
  placeholder?: SentMessage,
) {
  try {
    const agentContext = createAgentRuntimeContext(runtimeContext, baseArgs.thread, baseArgs.run)
    const agent = binding.definition || await getAgentFromRegistry(binding.name, agentContext)
    let result = await streamAgent(agent, agentContext, input)
    result = await binding.hooks?.afterRun?.({ ...baseArgs, input, result }) ?? result
    if (binding.hooks?.sendResponse) {
      await binding.hooks.sendResponse({ ...baseArgs, input, result })
      return
    }
    if (placeholder) {
      await placeholder.edit(isAsyncIterable(result) ? await collectStreamText(result) as never : result as never)
      return
    }
    await baseArgs.thread.post(result as never)
  }
  catch (error) {
    if (binding.hooks?.error) {
      await binding.hooks.error({ ...baseArgs, error, input })
      return
    }
    throw error
  }
}

export function createChatAgentWorkflowPayload<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  binding: ChatAgentBindingOptions<TRuntimeConfig, TWorkflow>,
  baseArgs: ChatAgentHookArgs<TRuntimeConfig, TWorkflow>,
  input: AgentRunInput,
  placeholder?: SentMessage,
  runtimeContext?: ResolvedChatRuntimeContext<TRuntimeConfig>,
): ChatAgentWorkflowPayload {
  return {
    agentName: binding.name,
    channelId: getEntityId(baseArgs.channel),
    cloudflare: runtimeContext?.cloudflare,
    dev: runtimeContext?.dev,
    history: baseArgs.history,
    input,
    message: toChatMessageSnapshot(baseArgs.message),
    placeholder: placeholder ? toChatMessageSnapshot(placeholder) : undefined,
    run: baseArgs.run,
    threadId: getEntityId(baseArgs.thread),
  }
}

export function createAgentDirectMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeContext: ResolvedChatRuntimeContext<TRuntimeConfig>,
  binding: ChatAgentBindingOptions<TRuntimeConfig, TWorkflow>,
  workflow: TWorkflow,
  options: { fallbackStreamingPlaceholderText?: ChatStreamingPlaceholder<TRuntimeConfig> } = {},
): ChatDirectMessageHook<TRuntimeConfig, TWorkflow> {
  return async (args) => {
    const { channel, context, message, runtimeConfig, thread } = args
    const historyOptions = normalizeAgentHistory(binding.history)
    const sourceMessages = historyOptions.enabled
      ? await collectThreadMessages(thread, message, historyOptions.maxMessages)
      : [message]
    const history = toViteHubMessages(sourceMessages)
    const run = {
      channelId: getEntityId(channel),
      messageId: getEntityId(message),
      platform: runtimeContext.platform,
      runId: createRunId(),
      threadId: getEntityId(thread),
    } satisfies AgentRunMetadata
    const baseArgs = {
      bot,
      channel,
      context,
      history,
      message,
      run,
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
      const placeholderText = await resolvePlaceholder(options.fallbackStreamingPlaceholderText, baseArgs)
      const placeholder = placeholderText && !isDevtoolsThread(thread)
        ? await thread.post(placeholderText).catch(() => undefined) as SentMessage | undefined
        : undefined
      if (placeholderText && isDevtoolsThread(thread)) {
        await thread.startTyping(placeholderText)
      }
      if (binding.execution === "workflow" && !runtimeContext.dev) {
        if (!workflow?.run) {
          throw new Error("Chat agent execution \"workflow\" requires defineChat({ workflow }).")
        }
        await workflow.run(createChatAgentWorkflowPayload(binding, baseArgs, input, placeholder, runtimeContext), { id: run.runId })
        return
      }

      await executeChatAgentResponse(runtimeContext, binding, baseArgs, input, placeholder)
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
