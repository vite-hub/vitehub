import { Chat, Message, parseMarkdown, toPlainText } from "chat"
import { createError, defineEventHandler, readBody, setHeader } from "h3"

import { chatDevtoolsAdapterName, createDevtoolsAdapter as createBaseDevtoolsAdapter } from "../devtools.ts"
import { chatDevtoolsClearRpc, chatDevtoolsGetStateRpc, chatDevtoolsSendRpc } from "../devtools-shared.ts"
import { resolveChat } from "../index.ts"
import { createMemoryChatStateAdapter } from "../runtime/memory-state.ts"
import { getChatRuntimeConfig } from "../runtime/nitro-runtime-config.ts"
import { toFetchRequest } from "./handler.ts"

import type { Adapter, Chat as ChatInstance, Message as ChatMessage, RawMessage } from "chat"
import type { EventHandler, H3Event } from "h3"
import type { ChatDevtoolsAdapter, ChatDevtoolsConversation, ChatDevtoolsMessage, ChatDevtoolsMetadata, ChatDevtoolsStateResult, ChatDevtoolsStreamEvent } from "../devtools.ts"
import type { ChatInput } from "../types.ts"
import type { NitroChatRuntimeConfig, NitroChatRuntimeContext } from "./handler.ts"

type ChatLoader = () => Promise<ChatInput>
type ChatDevtoolsRegistry = Record<string, ChatLoader>
type MaybePromise<T> = T | Promise<T>
type ChatDevtoolsMetadataResolver = () => MaybePromise<ChatDevtoolsMetadata | undefined>
type ChatDevtoolsMetadataInput =
  | ChatDevtoolsMetadata
  | ChatDevtoolsMetadataResolver
  | Record<string, ChatDevtoolsMetadata | ChatDevtoolsMetadataResolver | undefined>

interface ChatDevtoolsSession {
  messages: ChatDevtoolsMessage[]
  name: string
  state: ReturnType<typeof createMemoryChatStateAdapter>
  typingMessageId?: string
}

interface ChatDevtoolsHandlerState {
  metadata: ChatDevtoolsMetadataInput
  registry: ChatDevtoolsRegistry
  sessions: Map<string, ChatDevtoolsSession>
  selected?: string
}

type ChatDevtoolsBridgeBody = {
  action?: string
  chat?: string
  stream?: boolean
  text?: string
}
type ChatDevtoolsAction = "clear" | "get-state" | "send"

interface CloudflareRuntimeCarrier {
  context?: {
    cloudflare?: {
      context?: unknown
      env?: Record<string, unknown>
    }
  }
  runtime?: {
    cloudflare?: {
      context?: unknown
      env?: Record<string, unknown>
    }
  }
}

export interface ChatDevtoolsHandlerOptions {
  inferredName?: string
  metadata?: ChatDevtoolsMetadata | ChatDevtoolsMetadataResolver
}

export interface ChatDevtoolsRegistryHandlerOptions {
  metadata?: ChatDevtoolsMetadataInput
}

function createMemo(): NitroChatRuntimeContext["memo"] {
  const values = new Map<string, unknown>()
  return (key, create) => {
    if (!values.has(key)) values.set(key, create())
    return values.get(key) as never
  }
}

function getCloudflareRuntime(event: H3Event, runtimeConfig: NitroChatRuntimeConfig): NitroChatRuntimeContext["cloudflare"] | undefined {
  const carrier = event as CloudflareRuntimeCarrier
  const requestCarrier = event.req as unknown as CloudflareRuntimeCarrier
  const runtime = carrier.context?.cloudflare
    || carrier.runtime?.cloudflare
    || requestCarrier.context?.cloudflare
    || requestCarrier.runtime?.cloudflare

  if (!runtime) {
    return undefined
  }

  return {
    context: runtime.context,
    durableObjectStateName: (runtimeConfig.chat as { cloudflare?: { durableObjectState?: { name?: string } } } | undefined)?.cloudflare?.durableObjectState?.name,
    env: runtime.env,
  }
}

function normalizeChatDevtoolsAction(action: string): ChatDevtoolsAction | undefined {
  if (action === "get-state" || action === chatDevtoolsGetStateRpc) return "get-state"
  if (action === "send" || action === chatDevtoolsSendRpc) return "send"
  if (action === "clear" || action === chatDevtoolsClearRpc) return "clear"
}

function createChatDevtoolsMessage(role: ChatDevtoolsMessage["role"], text: string): ChatDevtoolsMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
  }
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

function createSessionDevtoolsAdapter(session: ChatDevtoolsSession, onChange?: () => void | Promise<void>): Adapter {
  const adapter = createBaseDevtoolsAdapter()

  async function syncAdapterMessages() {
    const messages = adapter.getDevtoolsState(session.name).chats[0]?.messages || []
    for (const message of messages) {
      const existing = session.messages.find(item => item.id === message.id)
      if (existing) Object.assign(existing, message)
      else session.messages.push(message)
    }
    await onChange?.()
  }

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
      await syncAdapterMessages()
      return result
    },
    fetchMessages: async () => ({ messages: [...session.messages] as never }),
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
      await syncAdapterMessages()
      return result
    },
    removeReaction: async () => {},
    renderFormatted: content => toPlainText(content),
    startTyping: async (_threadId, status) => {
      await adapter.startTyping(_threadId, status)
      await syncAdapterMessages()
    },
  }
}

function createRuntimeContext(event: H3Event): NitroChatRuntimeContext {
  const runtimeConfig = getChatRuntimeConfig(event) as NitroChatRuntimeConfig
  return {
    cloudflare: getCloudflareRuntime(event, runtimeConfig),
    dev: true,
    event,
    memo: createMemo(),
    platform: "devtools",
    request: toFetchRequest(event),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: task => event.waitUntil(task),
  }
}

function resolveRegistryModule(module: unknown): ChatInput {
  return typeof module === "object" && module !== null && "default" in module
    ? (module as { default: ChatInput }).default
    : module as ChatInput
}

function getChatNames(state: ChatDevtoolsHandlerState): string[] {
  return Object.keys(state.registry)
}

function getSession(state: ChatDevtoolsHandlerState, name: string): ChatDevtoolsSession {
  let session = state.sessions.get(name)
  if (!session) {
    session = { messages: [], name, state: createMemoryChatStateAdapter() }
    state.sessions.set(name, session)
  }
  return session
}

function normalizeDevtoolsMetadata(metadata: ChatDevtoolsMetadata | undefined): Required<ChatDevtoolsMetadata> {
  return {
    files: metadata?.files ? [...metadata.files] : [],
    instructions: metadata?.instructions ? [...metadata.instructions] : [],
    tools: metadata?.tools ? [...metadata.tools] : [],
  }
}

async function resolveDevtoolsMetadata(metadata: ChatDevtoolsMetadata | ChatDevtoolsMetadataResolver | undefined) {
  return normalizeDevtoolsMetadata(typeof metadata === "function" ? await metadata() : metadata)
}

async function metadataForChat(metadata: ChatDevtoolsMetadataInput | undefined, selected: string | undefined): Promise<Required<ChatDevtoolsMetadata>> {
  if (!metadata) return normalizeDevtoolsMetadata(undefined)
  if (Array.isArray((metadata as ChatDevtoolsMetadata).files)
    || Array.isArray((metadata as ChatDevtoolsMetadata).instructions)
    || Array.isArray((metadata as ChatDevtoolsMetadata).tools)) {
    return normalizeDevtoolsMetadata(metadata as ChatDevtoolsMetadata)
  }
  if (typeof metadata === "function") {
    return await resolveDevtoolsMetadata(metadata)
  }
  return await resolveDevtoolsMetadata(selected ? (metadata as Record<string, ChatDevtoolsMetadata | ChatDevtoolsMetadataResolver | undefined>)[selected] : undefined)
}

async function resolveDevtoolsChat(event: H3Event, state: ChatDevtoolsHandlerState, session: ChatDevtoolsSession): Promise<ChatInstance> {
  const loader = state.registry[session.name]
  if (!loader) {
    throw createError({
      statusCode: 404,
      statusMessage: `Unknown chat: ${session.name}`,
    })
  }

  const chat = resolveRegistryModule(await loader())
  const adapter = createSessionDevtoolsAdapter(session)
  const bot = await resolveChat(chat, createRuntimeContext(event), {
    adapters: { [chatDevtoolsAdapterName]: adapter },
    inferredName: session.name,
    state: session.state,
  })
  await bot.initialize()
  return bot
}

async function serializeState(state: ChatDevtoolsHandlerState, selected?: string): Promise<ChatDevtoolsStateResult> {
  const names = getChatNames(state)
  for (const name of names) getSession(state, name)

  const chats: ChatDevtoolsConversation[] = names.map(name => ({
    name,
    messages: [...getSession(state, name).messages],
  }))

  const nextSelected = selected && names.includes(selected)
    ? selected
    : state.selected && names.includes(state.selected)
      ? state.selected
      : names[0] || ""
  state.selected = nextSelected || undefined

  const metadata = await metadataForChat(state.metadata, nextSelected)
  return {
    chats,
    files: metadata.files,
    instructions: metadata.instructions,
    selected: nextSelected,
    tools: metadata.tools,
  }
}

async function sendDevtoolsMessage(
  event: H3Event,
  state: ChatDevtoolsHandlerState,
  input: { chat?: string, text?: string },
  onChange?: (next: ChatDevtoolsStateResult) => void | Promise<void>,
): Promise<ChatDevtoolsStateResult> {
  const text = input.text?.trim()
  if (!text) {
    throw createError({
      statusCode: 400,
      statusMessage: "Missing chat message text.",
    })
  }

  const selected = input.chat || getChatNames(state)[0]
  if (!selected) {
    throw createError({
      statusCode: 404,
      statusMessage: "No chats are registered for DevTools.",
    })
  }

  const session = getSession(state, selected)
  state.selected = selected
  const adapter = createSessionDevtoolsAdapter(session, async () => {
    await onChange?.(await serializeState(state, selected))
  })
  const message = createSdkMessage(session, text)
  session.messages.push(createChatDevtoolsMessage("user", text))
  await onChange?.(await serializeState(state, selected))

  const bot = await resolveDevtoolsChat(event, state, session)
  await bot.handleIncomingMessage(adapter, message.threadId, message)

  return await serializeState(state, selected)
}

function createChatDevtoolsStreamResponse(run: (emit: (event: ChatDevtoolsStreamEvent) => void, signal: AbortSignal) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const abortController = new AbortController()
  let closed = false

  function emit(controller: ReadableStreamDefaultController<Uint8Array>, event: ChatDevtoolsStreamEvent): void {
    if (closed || abortController.signal.aborted) return
    try {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    }
    catch {
      closed = true
      abortController.abort()
    }
  }

  return new Response(new ReadableStream({
    start(controller) {
      run(event => emit(controller, event), abortController.signal)
        .then(() => {
          if (closed || abortController.signal.aborted) return
          emit(controller, { type: "done" })
          if (!closed) {
            closed = true
            controller.close()
          }
        })
        .catch((cause) => {
          if (closed || abortController.signal.aborted) return
          emit(controller, {
            type: "error",
            message: cause instanceof Error ? cause.message : "Chat DevTools stream failed.",
          })
          if (!closed) {
            closed = true
            controller.close()
          }
        })
    },
    cancel() {
      closed = true
      abortController.abort()
    },
  }), {
    headers: { "content-type": "application/x-ndjson" },
  })
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

function parseChatDevtoolsBridgeBody(rawBody: ChatDevtoolsBridgeBody | string | undefined): ChatDevtoolsBridgeBody | undefined {
  if (typeof rawBody !== "string") {
    return rawBody
  }

  try {
    return JSON.parse(rawBody) as ChatDevtoolsBridgeBody
  }
  catch {
    throw createError({
      statusCode: 400,
      statusMessage: "Malformed chat devtools payload.",
    })
  }
}

export function defineChatDevtoolsSingletonHandler(): EventHandler {
  return defineEventHandler(async (event) => {
    const body = await readBody<ChatDevtoolsBridgeBody>(event)
    const input = body || {}
    const { adapter, chat } = getSingletonDevtoolsAdapter()
    const action = typeof input.action === "string" ? normalizeChatDevtoolsAction(input.action) : "get-state"
    if (action === "get-state") {
      return adapter.getDevtoolsState(input.chat)
    }

    if (action === "clear") {
      adapter.clearDevtoolsTranscript(input.chat)
      return adapter.getDevtoolsState(input.chat)
    }

    if (action === "send") {
      const text = input.text?.trim()
      if (!text) {
        throw createError({
          statusCode: 400,
          statusMessage: "Missing chat message text.",
        })
      }

      if (input.stream) {
        return createChatDevtoolsStreamResponse(async (emit, signal) => {
          const emitState = () => emit({ type: "state" as const, state: adapter.getDevtoolsState(input.chat) })
          const message = adapter.createDevtoolsMessage(text, input.chat)
          emitState()
          const interval = setInterval(emitState, 250)
          signal.addEventListener("abort", () => clearInterval(interval), { once: true })
          try {
            await chat.processMessage(adapter, message.threadId, message, { waitUntil: task => event.waitUntil(task) })
          }
          finally {
            clearInterval(interval)
          }
          emitState()
        })
      }

      const message = adapter.createDevtoolsMessage(text, input.chat)
      await chat.processMessage(adapter, message.threadId, message, { waitUntil: task => event.waitUntil(task) })
      return adapter.getDevtoolsState(input.chat)
    }

    throw createError({
      statusCode: 400,
      statusMessage: `Unknown chat devtools action: ${(body as { action: string }).action}`,
    })
  })
}

async function clearDevtoolsMessages(state: ChatDevtoolsHandlerState, input: { chat?: string }): Promise<ChatDevtoolsStateResult> {
  const selected = input.chat || getChatNames(state)[0]
  if (!selected) return await serializeState(state)
  state.selected = selected
  getSession(state, selected).messages = []
  return await serializeState(state, selected)
}

export function defineChatDevtoolsRegistryHandler(registry: ChatDevtoolsRegistry, options: ChatDevtoolsRegistryHandlerOptions = {}): EventHandler {
  const state: ChatDevtoolsHandlerState = {
    metadata: options.metadata || {},
    registry,
    sessions: new Map(),
  }

  return defineEventHandler(async (event) => {
    setHeader(event, "access-control-allow-origin", "*")
    const body = parseChatDevtoolsBridgeBody(await readBody<ChatDevtoolsBridgeBody | string>(event))
    if (!body || typeof body.action !== "string") {
      throw createError({
        statusCode: 400,
        statusMessage: "Missing chat devtools action.",
      })
    }

    const action = normalizeChatDevtoolsAction(body.action)
    if (body.chat && getChatNames(state).includes(body.chat)) {
      state.selected = body.chat
    }
    if (action === "get-state") {
      return await serializeState(state, body.chat)
    }
    if (action === "send") {
      if (body.stream) {
        return createChatDevtoolsStreamResponse(async (emit, signal) => {
          const selected = body.chat || getChatNames(state)[0]
          const emitState = async () => emit({ type: "state" as const, state: await serializeState(state, selected) })
          const interval = setInterval(() => {
            void emitState()
          }, 250)
          signal.addEventListener("abort", () => clearInterval(interval), { once: true })
          try {
            const finalState = await sendDevtoolsMessage(event, state, body, next => emit({ type: "state", state: next }))
            emit({ type: "state", state: finalState })
          }
          finally {
            clearInterval(interval)
          }
        })
      }
      return await sendDevtoolsMessage(event, state, body)
    }
    if (action === "clear") {
      return await clearDevtoolsMessages(state, body)
    }

    throw createError({
      statusCode: 400,
      statusMessage: `Unknown chat devtools action: ${(body as { action: string }).action}`,
    })
  })
}

export function defineChatDevtoolsHandler(chat: ChatInput, options: ChatDevtoolsHandlerOptions = {}): EventHandler {
  const name = options.inferredName || "default"
  return defineChatDevtoolsRegistryHandler({
    [name]: async () => chat,
  }, { metadata: options.metadata })
}
