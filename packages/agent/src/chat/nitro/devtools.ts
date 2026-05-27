import { createError, defineEventHandler, readBody, setHeader } from "h3"

import { getAgentFromRegistry, streamAgentTrigger } from "../../index.ts"
import { chatDevtoolsClearRpc, chatDevtoolsGetStateRpc, chatDevtoolsSendRpc } from "../devtools-shared.ts"
import { getChatDefinitionOptions } from "../runtime/definition.ts"
import { getChatRuntimeConfig } from "../runtime/nitro-runtime-config.ts"
import { createMemoryChatStateAdapter } from "../runtime/memory-state.ts"
import { toFetchRequest } from "./handler.ts"

import type { EventHandler, H3Event } from "h3"
import type { UIMessage } from "ai"
import type { AgentChatMessageTriggerInput, AgentRunInput, AgentRunMetadata } from "../../index.ts"
import type { ChatDevtoolsConversation, ChatDevtoolsMessage, ChatDevtoolsMetadata, ChatDevtoolsStateResult, ChatDevtoolsStreamEvent } from "../devtools.ts"
import type { ChatAgentBindingOptions, ChatInput } from "../types.ts"
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
  thinkingFallback?: string | null
  uiMessages: UIMessage[]
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
type ReadUIMessageStream = typeof import("ai").readUIMessageStream

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
    session = { messages: [], name, state: createMemoryChatStateAdapter(), uiMessages: [] }
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

async function serializeState(state: ChatDevtoolsHandlerState, selected?: string): Promise<ChatDevtoolsStateResult> {
  const names = getChatNames(state)
  for (const name of names) getSession(state, name)

  const chats: ChatDevtoolsConversation[] = names.map(name => ({
    name,
    messages: [...getSession(state, name).messages],
    uiMessages: [...getSession(state, name).uiMessages],
  }))

  const nextSelected = selected && names.includes(selected)
    ? selected
    : state.selected && names.includes(state.selected)
      ? state.selected
      : names[0] || ""
  state.selected = nextSelected || undefined

  const metadata = await metadataForChat(state.metadata, nextSelected)
  const selectedSession = nextSelected ? getSession(state, nextSelected) : undefined
  return {
    chats,
    files: metadata.files,
    instructions: metadata.instructions,
    selected: nextSelected,
    thinkingFallback: selectedSession?.thinkingFallback ?? null,
    tools: metadata.tools,
    uiMessages: selectedSession ? [...selectedSession.uiMessages] : [],
  }
}

function normalizeDevtoolsAgentBinding(binding: unknown): ChatAgentBindingOptions {
  if (typeof binding === "object" && binding !== null && "resolve" in binding && typeof (binding as { resolve?: unknown }).resolve === "function") {
    return {
      definition: binding as ChatAgentBindingOptions["definition"],
      name: (binding as { name?: unknown }).name as string | undefined || "devtools-agent",
    }
  }
  return typeof binding === "string" ? { name: binding } : binding as ChatAgentBindingOptions
}

function createRunMetadata(session: ChatDevtoolsSession, userMessageId: string): AgentRunMetadata {
  return {
    channelId: `devtools:${session.name}`,
    messageId: userMessageId,
    platform: "devtools",
    runId: globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    threadId: `devtools:${session.name}:thread`,
  }
}

function createUserUIMessage(text: string): UIMessage {
  return {
    id: `devtools-user-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text }],
  }
}

function uiMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is { text: string, type: "text" } => part.type === "text" && typeof (part as { text?: unknown }).text === "string")
    .map(part => part.text)
    .join("")
}

function createDevtoolsHookArgs(
  run: AgentRunMetadata,
  userMessage: UIMessage,
  agentInput: AgentRunInput,
) {
  return {
    channel: { id: run.channelId },
    history: agentInput.messages || [],
    input: agentInput,
    message: {
      id: userMessage.id,
      metadata: { dateSent: new Date().toISOString() },
      text: uiMessageText(userMessage),
    },
    run,
    thread: { id: run.threadId },
  }
}

async function sendDevtoolsUIMessage(
  event: H3Event,
  state: ChatDevtoolsHandlerState,
  input: { chat?: string, stream?: boolean, text?: string },
  onChange?: (next: ChatDevtoolsStateResult) => void | Promise<void>,
): Promise<ChatDevtoolsStateResult> {
  if (!input.stream) {
    throw createError({
      statusCode: 400,
      statusMessage: "AI SDK Chat DevTools sends require stream: true.",
    })
  }

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

  const loader = state.registry[selected]
  if (!loader) {
    throw createError({
      statusCode: 404,
      statusMessage: `Unknown chat: ${selected}`,
    })
  }

  const chat = resolveRegistryModule(await loader())
  const options = getChatDefinitionOptions(chat)
  const agentBinding = options?.agent
  if (!agentBinding) {
    throw createError({
      statusCode: 400,
      statusMessage: "AI SDK Chat DevTools requires defineChat({ agent }).",
    })
  }

  const binding = normalizeDevtoolsAgentBinding(agentBinding)
  const session = getSession(state, selected)
  state.selected = selected
  const userMessage = createUserUIMessage(text)
  const baseMessages = [...session.uiMessages, userMessage]
  const run = createRunMetadata(session, userMessage.id)
  const startedAt = new Date().toISOString()
  session.uiMessages = baseMessages
  session.thinkingFallback = null
  await onChange?.(await serializeState(state, selected))

  let agentInput: AgentRunInput | undefined
  try {
    const runtimeContext = { ...createRuntimeContext(event), run }
    const agent = binding.definition || await getAgentFromRegistry(binding.name, runtimeContext as never)
    const triggerInput: AgentChatMessageTriggerInput = {
      history: binding.history,
      messages: baseMessages,
      run,
      timeout: 90_000,
    }
    const stream = await streamAgentTrigger(agent as never, runtimeContext as never, "chat.message", triggerInput, {
      output: "ui-message-stream",
      async onInvocation(invocation) {
        agentInput = invocation.input
        const hookArgs = createDevtoolsHookArgs(run, userMessage, agentInput)
        const prepared = await binding.hooks?.prepareInput?.(hookArgs as never)
        if (prepared) {
          invocation.input = prepared
          agentInput = prepared
        }
        const beforeInput = await binding.hooks?.beforeRun?.({ ...hookArgs, input: agentInput } as never)
        if (beforeInput) {
          invocation.input = beforeInput
          agentInput = beforeInput
        }
        session.thinkingFallback = typeof invocation.metadata?.thinkingFallback === "string"
          ? invocation.metadata.thinkingFallback
          : typeof options.fallbackStreamingPlaceholderText === "string"
            ? options.fallbackStreamingPlaceholderText
          : null
        await onChange?.(await serializeState(state, selected))
      },
    }) as ReadableStream<never>
    const { readUIMessageStream } = await import("ai") as { readUIMessageStream: ReadUIMessageStream }
    let latestAssistant: UIMessage | undefined
    for await (const assistantMessage of readUIMessageStream({ stream })) {
      const now = new Date().toISOString()
      latestAssistant = {
        ...assistantMessage as UIMessage,
        metadata: {
          ...((assistantMessage as UIMessage).metadata as Record<string, unknown> | undefined),
          createdAt: startedAt,
          updatedAt: now,
        },
      }
      session.uiMessages = [...baseMessages, latestAssistant]
      await onChange?.(await serializeState(state, selected))
    }
    if (latestAssistant) {
      latestAssistant = {
        ...latestAssistant,
        metadata: {
          ...(latestAssistant.metadata as Record<string, unknown> | undefined),
          completedAt: new Date().toISOString(),
        },
      }
      session.uiMessages = [...baseMessages, latestAssistant]
      await onChange?.(await serializeState(state, selected))
    }
    await binding.hooks?.afterRun?.({ input: agentInput, result: latestAssistant, run } as never)
    return await serializeState(state, selected)
  }
  catch (error) {
    if (binding.hooks?.error) {
      await binding.hooks.error({ error, input: agentInput, run } as never)
      return await serializeState(state, selected)
    }
    throw error
  }
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

async function clearDevtoolsMessages(state: ChatDevtoolsHandlerState, input: { chat?: string }): Promise<ChatDevtoolsStateResult> {
  const selected = input.chat || getChatNames(state)[0]
  if (!selected) return await serializeState(state)
  state.selected = selected
  const session = getSession(state, selected)
  session.messages = []
  session.uiMessages = []
  session.thinkingFallback = null
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
      if (!body.stream) {
        throw createError({
          statusCode: 400,
          statusMessage: "Chat DevTools sends require stream: true.",
        })
      }
      return createChatDevtoolsStreamResponse(async (emit, signal) => {
        const finalState = await sendDevtoolsUIMessage(event, state, body, (next) => {
          if (!signal.aborted) emit({ type: "state", state: next })
        })
        if (!signal.aborted) emit({ type: "state", state: finalState })
      })
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
