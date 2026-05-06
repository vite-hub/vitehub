import { Chat, Message, parseMarkdown, toPlainText } from "chat"
import { createError, defineEventHandler, readBody } from "h3"

import { chatDevtoolsAdapterName, createDevtoolsAdapter as createBaseDevtoolsAdapter } from "../devtools.ts"
import { resolveChat } from "../index.ts"
import { createMemo } from "../runtime/context.ts"
import { getChatRuntimeConfig } from "../runtime/nitro-runtime-config.ts"

import type { Adapter, AdapterPostableMessage, Chat as ChatInstance, FormattedContent, Message as ChatMessage, RawMessage } from "chat"
import type { EventHandler, H3Event } from "h3"
import type { ChatDevtoolsAdapter, ChatDevtoolsBridgeRequest, ChatDevtoolsConversation, ChatDevtoolsMessage, ChatDevtoolsStateResult } from "../devtools.ts"
import type { ChatInput } from "../types.ts"
import type { NitroChatRuntimeConfig, NitroChatRuntimeContext } from "./handler.ts"

type ChatLoader = () => Promise<ChatInput<NitroChatRuntimeContext>>
type ChatDevtoolsRegistry = Record<string, ChatLoader>

interface ChatDevtoolsSession {
  bot?: Promise<ChatInstance>
  memo: ReturnType<typeof createMemo>
  messages: ChatDevtoolsMessage[]
  name: string
  typingMessageId?: string
}

interface ChatDevtoolsHandlerState {
  registry: ChatDevtoolsRegistry
  sessions: Map<string, ChatDevtoolsSession>
}

function createChatDevtoolsMessage(role: ChatDevtoolsMessage["role"], text: string): ChatDevtoolsMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  }
}

function renderPostableText(message: AdapterPostableMessage): string {
  if (typeof message === "string") {
    return message
  }
  if ("markdown" in message && typeof message.markdown === "string") {
    return message.markdown
  }
  if ("raw" in message && typeof message.raw === "string") {
    return message.raw
  }
  if ("ast" in message) {
    return toPlainText(message.ast as FormattedContent)
  }
  if ("card" in message) {
    return "[card]"
  }
  return JSON.stringify(message)
}

function createSdkMessage(session: ChatDevtoolsSession, text: string): ChatMessage {
  return new Message({
    id: `devtools-message-${Date.now()}`,
    threadId: `devtools:${session.name}:thread`,
    text,
    formatted: parseMarkdown(text),
    raw: { text },
    author: {
      fullName: "ViteHub DevTools",
      isBot: false,
      isMe: false,
      userId: "vitehub-devtools-user",
      userName: "devtools",
    },
    metadata: {
      dateSent: new Date(),
      edited: false,
    },
    attachments: [],
  })
}

function createSessionDevtoolsAdapter(session: ChatDevtoolsSession): Adapter {
  const adapter = createBaseDevtoolsAdapter()
  return {
    ...adapter,
    name: chatDevtoolsAdapterName,
    userName: "ViteHub Chat",
    channelIdFromThreadId: () => `devtools:${session.name}`,
    decodeThreadId: threadId => threadId,
    encodeThreadId: value => String(value),
    addReaction: async () => {},
    deleteMessage: async () => {},
    editMessage: async (threadId, messageId, message) => {
      const result = await adapter.editMessage(threadId, messageId, message)
      session.messages = adapter.getDevtoolsState(session.name).chats[0]?.messages || []
      return result
    },
    fetchMessages: async () => ({ messages: [] }),
    fetchThread: async threadId => ({
      id: threadId,
      channelId: `devtools:${session.name}`,
      isDM: true,
      metadata: {},
    }),
    handleWebhook: async () => new Response(null, { status: 204 }),
    initialize: async () => {},
    isDM: () => true,
    parseMessage: raw => raw as ChatMessage,
    postMessage: async (threadId, message): Promise<RawMessage> => {
      const result = await adapter.postMessage(threadId, message)
      session.messages = adapter.getDevtoolsState(session.name).chats[0]?.messages || []
      return result
    },
    removeReaction: async () => {},
    renderFormatted: content => toPlainText(content),
    startTyping: async (_threadId, status) => {
      await adapter.startTyping(_threadId, status)
      session.messages = adapter.getDevtoolsState(session.name).chats[0]?.messages || []
    },
  }
}

function createRuntimeContext(event: H3Event, session: ChatDevtoolsSession): NitroChatRuntimeContext {
  const runtimeConfig = getChatRuntimeConfig(event) as NitroChatRuntimeConfig
  return {
    dev: true,
    event,
    memo: session.memo,
    platform: "devtools",
    request: event.req as unknown as Request,
    runtime: "nitro",
    runtimeConfig,
    waitUntil: task => event.waitUntil(task),
  }
}

function resolveRegistryModule(module: unknown): ChatInput<NitroChatRuntimeContext> {
  return typeof module === "object" && module !== null && "default" in module
    ? (module as { default: ChatInput<NitroChatRuntimeContext> }).default
    : module as ChatInput<NitroChatRuntimeContext>
}

function getChatNames(state: ChatDevtoolsHandlerState): string[] {
  const names = Object.keys(state.registry)
  return names.length ? names : ["default"]
}

function getSession(state: ChatDevtoolsHandlerState, name: string): ChatDevtoolsSession {
  let session = state.sessions.get(name)
  if (!session) {
    session = { memo: createMemo(), messages: [], name }
    state.sessions.set(name, session)
  }
  return session
}

async function resolveDevtoolsChat(event: H3Event, state: ChatDevtoolsHandlerState, session: ChatDevtoolsSession): Promise<ChatInstance> {
  session.bot ||= (async () => {
    const loader = state.registry[session.name]
    if (!loader) {
      throw createError({
        statusCode: 404,
        statusMessage: `Unknown chat: ${session.name}`,
      })
    }

    const chat = resolveRegistryModule(await loader())
    const bot = await resolveChat(chat, createRuntimeContext(event, session), { inferredName: session.name })
    await bot.initialize()
    return bot
  })()
  return await session.bot
}

function serializeState(state: ChatDevtoolsHandlerState, selected?: string): ChatDevtoolsStateResult {
  const names = getChatNames(state)
  for (const name of names) getSession(state, name)

  const chats: ChatDevtoolsConversation[] = names.map(name => ({
    name,
    messages: [...getSession(state, name).messages],
  }))

  return {
    chats,
    selected: selected && names.includes(selected) ? selected : names[0]!,
  }
}

async function sendDevtoolsMessage(event: H3Event, state: ChatDevtoolsHandlerState, input: { chat?: string, text?: string }): Promise<ChatDevtoolsStateResult> {
  const text = input.text?.trim()
  if (!text) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing chat message text.",
    })
  }

  const selected = input.chat || getChatNames(state)[0]!
  const session = getSession(state, selected)
  const adapter = createSessionDevtoolsAdapter(session)
  const message = createSdkMessage(session, text)
  session.messages.push(createChatDevtoolsMessage("user", text))

  const bot = await resolveDevtoolsChat(event, state, session)
  await bot.handleIncomingMessage(adapter, message.threadId, message)

  return serializeState(state, selected)
}

function isChatDevtoolsAdapter(adapter: Adapter): adapter is ChatDevtoolsAdapter {
  return typeof (adapter as Partial<ChatDevtoolsAdapter>).getDevtoolsState === "function"
    && typeof (adapter as Partial<ChatDevtoolsAdapter>).createDevtoolsMessage === "function"
    && typeof (adapter as Partial<ChatDevtoolsAdapter>).clearDevtoolsTranscript === "function"
}

function getSingletonDevtoolsAdapter(): { adapter: ChatDevtoolsAdapter, chat: ChatInstance } {
  if (!Chat.hasSingleton()) {
    throw createError({
      statusCode: 500,
      statusMessage: "Chat DevTools requires a registered Chat singleton. Call chat.registerSingleton().",
    })
  }

  const chat = Chat.getSingleton()
  const adapter = chat.getAdapter(chatDevtoolsAdapterName as never)
  if (!isChatDevtoolsAdapter(adapter)) {
    throw createError({
      statusCode: 500,
      statusMessage: `Chat singleton must include adapters: { ${chatDevtoolsAdapterName}: createDevtoolsAdapter() }.`,
    })
  }
  return { adapter, chat }
}

export function defineChatDevtoolsSingletonHandler(): EventHandler {
  return defineEventHandler(async (event) => {
    const body = await readBody<ChatDevtoolsBridgeRequest>(event)
    const { adapter, chat } = getSingletonDevtoolsAdapter()
    if (!body || typeof body.action !== "string" || body.action === "get-state") {
      return adapter.getDevtoolsState()
    }

    if (body.action === "clear") {
      adapter.clearDevtoolsTranscript(body.chat)
      return adapter.getDevtoolsState(body.chat)
    }

    if (body.action === "send") {
      const text = body.text?.trim()
      if (!text) {
        throw createError({
          statusCode: 400,
          statusMessage: "Missing chat message text.",
        })
      }

      const message = adapter.createDevtoolsMessage(text, body.chat)
      chat.processMessage(adapter, message.threadId, message, { waitUntil: task => event.waitUntil(task) })
      return adapter.getDevtoolsState(body.chat)
    }

    throw createError({
      statusCode: 400,
      statusMessage: `Unknown chat devtools action: ${(body as { action: string }).action}`,
    })
  })
}

function clearDevtoolsMessages(state: ChatDevtoolsHandlerState, input: { chat?: string }): ChatDevtoolsStateResult {
  const selected = input.chat || getChatNames(state)[0]!
  getSession(state, selected).messages = []
  return serializeState(state, selected)
}

export function defineChatDevtoolsRegistryHandler(registry: ChatDevtoolsRegistry): EventHandler {
  const state: ChatDevtoolsHandlerState = {
    registry,
    sessions: new Map(),
  }

  return defineEventHandler(async (event) => {
    const body = await readBody<ChatDevtoolsBridgeRequest>(event)
    if (!body || typeof body.action !== "string") {
      throw createError({
        statusCode: 400,
        statusMessage: "Missing chat devtools action.",
      })
    }

    if (body.action === "get-state") {
      return serializeState(state)
    }
    if (body.action === "send") {
      return await sendDevtoolsMessage(event, state, body)
    }
    if (body.action === "clear") {
      return clearDevtoolsMessages(state, body)
    }

    throw createError({
      statusCode: 400,
      statusMessage: `Unknown chat devtools action: ${(body as { action: string }).action}`,
    })
  })
}

export function defineChatDevtoolsHandler(chat: ChatInput<NitroChatRuntimeContext>, options: { inferredName?: string } = {}): EventHandler {
  const name = options.inferredName || "default"
  return defineChatDevtoolsRegistryHandler({
    [name]: async () => chat,
  })
}
