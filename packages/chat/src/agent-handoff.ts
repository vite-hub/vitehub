import { getAgentFromRegistry, streamAgent } from "@vitehub/agent"
import { createMessage } from "@vitehub/messages"

import type {
  ChatAgentBindingOptions,
  ChatAgentHookArgs,
  ChatAgentRuntimeContext,
  ChatDirectMessageHook,
  ChatRuntimeConfig,
  ChatWorkflowHandle,
  ResolvedChatRuntimeContext,
} from "./types.ts"
import type { AgentRunInput } from "@vitehub/agent"
import type { Chat, Channel, Message as ChatSdkMessage, MessageContext, Thread } from "chat"
import type { Message } from "@vitehub/messages"

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
): ChatAgentRuntimeContext<TRuntimeConfig> {
  const runtime = context.runtime === "cloudflare"
    ? "cloudflare-agents"
    : context.runtime === "nitro" || context.runtime === "vercel"
      ? context.runtime
      : "unknown"

  return {
    capabilities: context.capabilities,
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

export function createAgentDirectMessageHook<
  TRuntimeConfig extends ChatRuntimeConfig,
  TWorkflow extends ChatWorkflowHandle<any, any> | undefined,
>(
  bot: Chat,
  runtimeContext: ResolvedChatRuntimeContext<TRuntimeConfig>,
  binding: ChatAgentBindingOptions<TRuntimeConfig, TWorkflow>,
  workflow: TWorkflow,
): ChatDirectMessageHook<TRuntimeConfig, TWorkflow> {
  return async (args) => {
    const { channel, context, message, runtimeConfig, thread } = args
    const historyOptions = normalizeAgentHistory(binding.history)
    const sourceMessages = historyOptions.enabled
      ? await collectThreadMessages(thread, message, historyOptions.maxMessages)
      : [message]
    const history = toViteHubMessages(sourceMessages)
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
