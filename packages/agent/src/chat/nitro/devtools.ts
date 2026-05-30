import { createError, defineEventHandler, readBody, setHeader } from "h3"

import { resolveAgentTriggers, streamAgentTrigger } from "../../index.ts"
import { chatDevtoolsClearRpc, chatDevtoolsGetStateRpc, chatDevtoolsSendRpc } from "../devtools-shared.ts"
import { createAgentRuntimeContext } from "../../runtime/context.ts"
import { getAgentRuntimeConfig } from "../../runtime/nitro-runtime-config.ts"
import { toFetchRequest } from "../../nitro/handler.ts"

import type { EventHandler, H3Event } from "h3"
import type { UIMessage } from "ai"
import type { AgentInput, AgentRunMetadata, AgentRuntimeConfig, AgentRuntimeContext } from "../../index.ts"
import type { AgentChatMessageTriggerInput } from "../../chat-trigger.ts"
import type { ChatDevtoolsConversation, ChatDevtoolsMetadata, ChatDevtoolsStateResult, ChatDevtoolsStreamEvent } from "../devtools.ts"

type AgentLoader = () => Promise<AgentRegistryModule>
type AgentDevtoolsRegistry = Record<string, AgentLoader>
type AgentRegistryModule = { default?: AgentInput<NitroAgentDevtoolsRuntimeContext> } | AgentInput<NitroAgentDevtoolsRuntimeContext>
type MaybePromise<T> = T | Promise<T>
type ChatDevtoolsMetadataResolver = () => MaybePromise<ChatDevtoolsMetadata | undefined>
type ChatDevtoolsMetadataInput =
  | ChatDevtoolsMetadata
  | ChatDevtoolsMetadataResolver
  | Record<string, ChatDevtoolsMetadata | ChatDevtoolsMetadataResolver | undefined>

interface ChatDevtoolsSession {
  name: string
  thinkingFallback?: string | null
  uiMessages: UIMessage[]
}

interface ChatDevtoolsHandlerState {
  metadata: ChatDevtoolsMetadataInput
  registry: AgentDevtoolsRegistry
  sessions: Map<string, ChatDevtoolsSession>
  selected?: string
}

interface NitroAgentDevtoolsRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
  hosting?: string
}

interface NitroAgentDevtoolsRuntimeContext extends AgentRuntimeContext<NitroAgentDevtoolsRuntimeConfig> {
  event?: H3Event
  request?: Request
  runtime: "nitro"
  runtimeConfig: NitroAgentDevtoolsRuntimeConfig
}

type ChatDevtoolsBridgeBody = {
  action?: string
  chat?: string
  stream?: boolean
  text?: string
}
type ChatDevtoolsAction = "clear" | "get-state" | "send"
type ReadUIMessageStream = typeof import("ai").readUIMessageStream

export interface AgentDevtoolsHandlerOptions {
  inferredName?: string
  metadata?: ChatDevtoolsMetadata | ChatDevtoolsMetadataResolver
}

export interface AgentDevtoolsRegistryHandlerOptions {
  metadata?: ChatDevtoolsMetadataInput
}

function normalizeChatDevtoolsAction(action: string): ChatDevtoolsAction | undefined {
  if (action === "get-state" || action === chatDevtoolsGetStateRpc) return "get-state"
  if (action === "send" || action === chatDevtoolsSendRpc) return "send"
  if (action === "clear" || action === chatDevtoolsClearRpc) return "clear"
}

function createRuntimeContext(event: H3Event): NitroAgentDevtoolsRuntimeContext {
  const runtimeConfig = getAgentRuntimeConfig(event) as NitroAgentDevtoolsRuntimeConfig
  return createAgentRuntimeContext({
    event,
    request: toFetchRequest(event),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: task => event.waitUntil(task),
  }) as NitroAgentDevtoolsRuntimeContext
}

function resolveRegistryModule(module: AgentRegistryModule): AgentInput<NitroAgentDevtoolsRuntimeContext> {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default as AgentInput<NitroAgentDevtoolsRuntimeContext>
    : module as AgentInput<NitroAgentDevtoolsRuntimeContext>
}

function getChatNames(state: ChatDevtoolsHandlerState): string[] {
  return Object.keys(state.registry)
}

function getSession(state: ChatDevtoolsHandlerState, name: string): ChatDevtoolsSession {
  let session = state.sessions.get(name)
  if (!session) {
    session = { name, uiMessages: [] }
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

async function chatCapableAgentRegistry(registry: AgentDevtoolsRegistry, context: NitroAgentDevtoolsRuntimeContext): Promise<AgentDevtoolsRegistry> {
  const result: AgentDevtoolsRegistry = {}
  for (const name of Object.keys(registry).sort()) {
    const agent = resolveRegistryModule(await registry[name]!())
    const triggers = await resolveAgentTriggers(agent as never, context as never)
    if (triggers["chat.message"]) {
      result[name] = registry[name]!
    }
  }
  return result
}

async function serializeState(state: ChatDevtoolsHandlerState, selected?: string): Promise<ChatDevtoolsStateResult> {
  const names = getChatNames(state)
  for (const name of names) getSession(state, name)

  const chats: ChatDevtoolsConversation[] = names.map(name => ({
    messages: [],
    name,
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

function createRunMetadata(session: ChatDevtoolsSession, userMessageId: string): AgentRunMetadata {
  return {
    channelId: `devtools:${session.name}`,
    messageId: userMessageId,
    origin: "devtools",
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

  const agent = resolveRegistryModule(await loader())
  const session = getSession(state, selected)
  state.selected = selected
  const userMessage = createUserUIMessage(text)
  const baseMessages = [...session.uiMessages, userMessage]
  const run = createRunMetadata(session, userMessage.id)
  const startedAt = new Date().toISOString()
  session.uiMessages = baseMessages
  session.thinkingFallback = null
  await onChange?.(await serializeState(state, selected))

  const runtimeContext = { ...createRuntimeContext(event), run }
  const triggerInput: AgentChatMessageTriggerInput = {
    messages: baseMessages,
    run,
    timeout: 90_000,
  }
  const stream = await streamAgentTrigger(agent as never, runtimeContext as never, "chat.message", triggerInput, {
    output: "ui-message-stream",
    async onInvocation(invocation) {
      session.thinkingFallback = typeof invocation.metadata?.thinkingFallback === "string"
        ? invocation.metadata.thinkingFallback
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
  session.uiMessages = []
  session.thinkingFallback = null
  return await serializeState(state, selected)
}

export function defineAgentDevtoolsRegistryHandler(registry: AgentDevtoolsRegistry, options: AgentDevtoolsRegistryHandlerOptions = {}): EventHandler {
  const state: ChatDevtoolsHandlerState = {
    metadata: options.metadata || {},
    registry,
    sessions: new Map(),
  }

  return defineEventHandler(async (event) => {
    setHeader(event, "access-control-allow-origin", "*")
    state.registry = await chatCapableAgentRegistry(registry, createRuntimeContext(event))
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

export function defineAgentDevtoolsHandler(agent: AgentInput<NitroAgentDevtoolsRuntimeContext>, options: AgentDevtoolsHandlerOptions = {}): EventHandler {
  const name = options.inferredName || "default"
  return defineAgentDevtoolsRegistryHandler({
    [name]: async () => agent,
  }, { metadata: options.metadata })
}
