import { Message, parseMarkdown, stringifyMarkdown } from "chat"

import { chatDevtoolsAdapterName, chatDevtoolsRoute } from "../devtools.ts"

import type {
  Adapter,
  AdapterPostableMessage,
  Chat,
  ChatInstance,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Message as ChatMessage,
  RawMessage,
  ThreadInfo,
} from "chat"
import type { ChatDevtoolsTranscriptMessage } from "../devtools.ts"

export { chatDevtoolsAdapterName, chatDevtoolsRoute }
export type { ChatDevtoolsResult, ChatDevtoolsTranscriptMessage } from "../devtools.ts"

const transcript = new Map<string, ChatDevtoolsTranscriptMessage[]>()
let messageId = 0

function createId(prefix: string): string {
  messageId += 1
  return `${prefix}-${Date.now()}-${messageId}`
}

function threadIdForChat(chatName: string): string {
  return `${chatDevtoolsAdapterName}:${chatName || "chat"}`
}

function chatNameFromThreadId(threadId: string): string {
  return threadId.split(":")[1] || "chat"
}

function getMessages(chatName: string): ChatDevtoolsTranscriptMessage[] {
  const key = chatName || "chat"
  const messages = transcript.get(key)
  if (messages) {
    return messages
  }

  const next: ChatDevtoolsTranscriptMessage[] = []
  transcript.set(key, next)
  return next
}

function addTranscriptMessage(chatName: string, message: Omit<ChatDevtoolsTranscriptMessage, "chat" | "timestamp">): ChatDevtoolsTranscriptMessage {
  const entry = {
    ...message,
    chat: chatName || "chat",
    timestamp: new Date().toISOString(),
  }
  getMessages(chatName).push(entry)
  return entry
}

function normalizePostableMessage(message: AdapterPostableMessage): string {
  if (typeof message === "string") {
    return message
  }
  if ("raw" in message && typeof message.raw === "string") {
    return message.raw
  }
  if ("markdown" in message && typeof message.markdown === "string") {
    return message.markdown
  }
  if ("ast" in message) {
    return stringifyMarkdown(message.ast)
  }
  if ("fallbackText" in message && typeof message.fallbackText === "string") {
    return message.fallbackText
  }
  return "[Unsupported DevTools message]"
}

function createRawMessage(chatName: string, id: string, threadId: string, text: string): RawMessage<ChatDevtoolsTranscriptMessage> {
  const entry = addTranscriptMessage(chatName, {
    author: "assistant",
    id,
    text,
    threadId,
  })
  return {
    id,
    raw: entry,
    threadId,
  }
}

function toChatMessage(entry: ChatDevtoolsTranscriptMessage): ChatMessage<ChatDevtoolsTranscriptMessage> {
  return new Message({
    attachments: [],
    author: {
      fullName: entry.author === "assistant" ? "Assistant" : "Developer",
      isBot: entry.author === "assistant",
      isMe: entry.author === "assistant",
      userId: entry.author,
      userName: entry.author,
    },
    formatted: parseMarkdown(entry.text),
    id: entry.id,
    metadata: {
      dateSent: new Date(entry.timestamp),
      edited: false,
    },
    raw: entry,
    text: entry.text,
    threadId: entry.threadId,
  })
}

function replaceTranscriptMessage(threadId: string, messageId: string, text: string): ChatDevtoolsTranscriptMessage {
  const chatName = chatNameFromThreadId(threadId)
  const messages = getMessages(chatName)
  const existing = messages.find(message => message.id === messageId)
  if (existing) {
    existing.text = text
    existing.timestamp = new Date().toISOString()
    return existing
  }

  return addTranscriptMessage(chatName, {
    author: "assistant",
    id: messageId,
    text,
    threadId,
  })
}

export function getChatDevtoolsTranscript(chatName?: string): ChatDevtoolsTranscriptMessage[] {
  if (chatName) {
    return [...getMessages(chatName)]
  }

  return [...transcript.values()].flat()
}

export function clearChatDevtoolsTranscript(chatName?: string): void {
  if (chatName) {
    transcript.set(chatName, [])
    return
  }

  transcript.clear()
}

export function createChatDevtoolsAdapter(userName: string): Adapter<string, ChatDevtoolsTranscriptMessage> {
  return {
    addReaction: unsupported,
    channelIdFromThreadId: threadId => threadId,
    decodeThreadId: threadId => threadId,
    deleteMessage: unsupported,
    editMessage: async (threadId, messageId, message) => {
      const entry = replaceTranscriptMessage(threadId, messageId, normalizePostableMessage(message))
      return { id: messageId, raw: entry, threadId }
    },
    encodeThreadId: threadId => threadId,
    fetchMessages: async (threadId, _options?: FetchOptions): Promise<FetchResult<ChatDevtoolsTranscriptMessage>> => {
      const chatName = chatNameFromThreadId(threadId)
      return {
        messages: getMessages(chatName).map(toChatMessage),
      }
    },
    fetchThread: async (threadId): Promise<ThreadInfo> => ({
      channelId: threadId,
      id: threadId,
      isDM: true,
      metadata: {},
    }),
    handleWebhook: async () => new Response(null, { status: 204 }),
    initialize: async (_chat: ChatInstance) => {},
    isDM: () => true,
    name: chatDevtoolsAdapterName,
    parseMessage: toChatMessage,
    postMessage: async (threadId, message) => createRawMessage(chatNameFromThreadId(threadId), createId("assistant"), threadId, normalizePostableMessage(message)),
    removeReaction: unsupported,
    renderFormatted: (content: FormattedContent) => stringifyMarkdown(content),
    startTyping: async () => {},
    userName,
  }
}

export async function submitChatDevtoolsMessage(
  bot: Chat,
  chatName: string,
  text: string,
  waitUntil: (task: Promise<unknown>) => void,
): Promise<void> {
  const normalizedChatName = chatName || "chat"
  const threadId = threadIdForChat(normalizedChatName)
  const adapter = createChatDevtoolsAdapter(bot.getUserName())
  await adapter.initialize(bot)
  await bot.initialize()

  const message = addTranscriptMessage(normalizedChatName, {
    author: "user",
    id: createId("user"),
    text,
    threadId,
  })
  const task = (async () => {
    try {
      const directDispatch = bot as unknown as {
        dispatchToHandlers?: (adapter: Adapter, threadId: string, message: ChatMessage<ChatDevtoolsTranscriptMessage>, context?: unknown) => Promise<void>
        handleIncomingMessage?: (adapter: Adapter, threadId: string, message: ChatMessage<ChatDevtoolsTranscriptMessage>) => Promise<void>
      }
      if (typeof directDispatch.dispatchToHandlers === "function") {
        await directDispatch.dispatchToHandlers(adapter, threadId, toChatMessage(message), { platform: chatDevtoolsAdapterName })
      }
      else if (typeof directDispatch.handleIncomingMessage === "function") {
        await directDispatch.handleIncomingMessage(adapter, threadId, toChatMessage(message))
      }
      else {
        bot.processMessage(adapter, threadId, toChatMessage(message), { waitUntil })
      }
    }
    catch (error) {
      await adapter.postMessage(threadId, `DevTools message failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
  waitUntil(task)
}

async function unsupported(): Promise<never> {
  throw new Error("ViteHub chat DevTools only supports sending messages.")
}
