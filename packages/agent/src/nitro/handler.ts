import { Chat } from "chat"
import { createError, defineEventHandler, getRouterParam } from "h3"

import { getChatCapabilityOptions } from "../chat-trigger.ts"
import { normalizeCapabilities } from "../capability-runtime.ts"
import { resolveAgent, resolveAgentTriggers, runAgent, streamAgent, streamAgentTrigger } from "../index.ts"
import { getHttpErrorMessage, getHttpErrorStatusCode } from "../http-error.ts"
import { formatUnknownAgentMessage } from "../registry-error.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { getAgentRuntimeConfig } from "../runtime/nitro-runtime-config.ts"

import type { Adapter, Attachment, ChatConfig, Channel, Lock, Message as ChatMessage, QueueEntry, SentMessage, StateAdapter, Thread } from "chat"
import type { EventHandler, H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"
import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type {
  AgentCapabilityDefinition,
  AgentChatOptions,
  AgentHandlerOptions,
  AgentInput,
  AgentRegistryHandlerOptions,
  AgentRunMetadata,
  AgentRequestBody,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeHooks,
  MaybePromise,
} from "../types.ts"

export interface NitroAgentRuntimeConfig extends NitroRuntimeConfig, AgentRuntimeConfig {}

export interface NitroAgentRuntimeContext extends AgentRuntimeContext<NitroAgentRuntimeConfig> {
  event?: H3Event
  request?: Request
  runtime: "nitro"
  runtimeConfig: NitroAgentRuntimeConfig
}

type AgentRegistryModule = { default?: AgentInput<NitroAgentRuntimeContext> } | AgentInput<NitroAgentRuntimeContext>
type AgentRegistry = Record<string, () => Promise<AgentRegistryModule>>
type WorkspaceAgentOptions = { capabilities?: AgentCapabilityDefinition[] }
type WorkspaceAgentDefinition = { __vitehubWorkspaceAgentOptions?: WorkspaceAgentOptions }
type ChatConfigRecord = Omit<ChatConfig<Record<string, Adapter>>, "adapters" | "fallbackStreamingPlaceholderText" | "state" | "userName">
type MemoryValue = { expiresAt?: number, value: unknown }
type MemoryList = { expiresAt?: number, values: unknown[] }

type RequestInitWithDuplex = RequestInit & { duplex?: "half" }
type RequestHeaders = NonNullable<RequestInit["headers"]>

interface RequestLike {
  body?: RequestInit["body"] | null
  headers?: RequestHeaders | Record<string, string | string[] | undefined>
  method?: string
  url?: string | URL
  [Symbol.asyncIterator]?: unknown
}

export interface AgentChatWebhookRegistryHandlerOptions {
  agentParam?: string
  platform?: string
  platformParam?: string
}

const defaultChatStates = new WeakMap<AgentChatOptions, StateAdapter>()
const configuredChatStates = new WeakMap<AgentChatOptions, StateAdapter>()

function memoryExpiresAt(ttlMs: number | undefined): number | undefined {
  return typeof ttlMs === "number" && ttlMs > 0 ? Date.now() + ttlMs : undefined
}

function isExpired(value: { expiresAt?: number } | undefined): boolean {
  return typeof value?.expiresAt === "number" && value.expiresAt <= Date.now()
}

function createMemoryChatState(): StateAdapter {
  const values = new Map<string, MemoryValue>()
  const lists = new Map<string, MemoryList>()
  const subscriptions = new Set<string>()
  const queues = new Map<string, QueueEntry[]>()
  const locks = new Map<string, Lock>()

  return {
    async acquireLock(threadId, ttlMs) {
      const current = locks.get(threadId)
      if (current && current.expiresAt > Date.now()) return null
      const lock = { expiresAt: Date.now() + ttlMs, threadId, token: `${Date.now()}-${Math.random().toString(36).slice(2)}` }
      locks.set(threadId, lock)
      return lock
    },
    async appendToList(key, value, options) {
      const current = lists.get(key)
      const nextValues = isExpired(current) ? [value] : [...(current?.values || []), value]
      lists.set(key, {
        expiresAt: memoryExpiresAt(options?.ttlMs),
        values: typeof options?.maxLength === "number" ? nextValues.slice(-options.maxLength) : nextValues,
      })
    },
    async connect() {},
    async delete(key) {
      values.delete(key)
      lists.delete(key)
    },
    async dequeue(threadId) {
      const queue = queues.get(threadId) || []
      const entry = queue.shift() || null
      if (queue.length) queues.set(threadId, queue)
      else queues.delete(threadId)
      return entry
    },
    async disconnect() {},
    async enqueue(threadId, entry, maxSize) {
      const queue = queues.get(threadId) || []
      queue.push(entry)
      queues.set(threadId, queue.slice(-maxSize))
      return queues.get(threadId)!.length
    },
    async extendLock(lock, ttlMs) {
      const current = locks.get(lock.threadId)
      if (current?.token !== lock.token) return false
      current.expiresAt = Date.now() + ttlMs
      return true
    },
    async forceReleaseLock(threadId) {
      locks.delete(threadId)
    },
    async get(key) {
      const entry = values.get(key)
      if (isExpired(entry)) {
        values.delete(key)
        return null
      }
      return entry?.value as never || null
    },
    async getList(key) {
      const entry = lists.get(key)
      if (isExpired(entry)) {
        lists.delete(key)
        return []
      }
      return entry?.values as never || []
    },
    async isSubscribed(threadId) {
      return subscriptions.has(threadId)
    },
    async queueDepth(threadId) {
      return queues.get(threadId)?.length || 0
    },
    async releaseLock(lock) {
      if (locks.get(lock.threadId)?.token === lock.token) locks.delete(lock.threadId)
    },
    async set(key, value, ttlMs) {
      values.set(key, { expiresAt: memoryExpiresAt(ttlMs), value })
    },
    async setIfNotExists(key, value, ttlMs) {
      const current = values.get(key)
      if (current && !isExpired(current)) return false
      values.set(key, { expiresAt: memoryExpiresAt(ttlMs), value })
      return true
    },
    async subscribe(threadId) {
      subscriptions.add(threadId)
    },
    async unsubscribe(threadId) {
      subscriptions.delete(threadId)
    },
  }
}

function getDefaultChatState(options: AgentChatOptions): StateAdapter {
  const current = defaultChatStates.get(options)
  if (current) return current
  const state = createMemoryChatState()
  defaultChatStates.set(options, state)
  return state
}

function normalizeHeaders(headers: RequestLike["headers"]): RequestHeaders | undefined {
  if (!headers || headers instanceof Headers || Array.isArray(headers)) {
    return headers
  }

  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      continue
    }
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item)
    }
    else {
      normalized.set(name, value)
    }
  }
  return normalized
}

function getRequestURL(event: H3Event, req: RequestLike, headers: RequestHeaders | undefined): string | URL {
  if (event.url) {
    return event.url
  }
  if (req.url && String(req.url).startsWith("http")) {
    return req.url
  }

  const headerMap = new Headers(headers)
  const host = headerMap.get("host") || "localhost"
  const protocol = headerMap.get("x-forwarded-proto") || "http"
  return new URL(String(req.url || "/"), `${protocol}://${host}`)
}

function getRequestBody(method: string, req: RequestLike): RequestInit["body"] | undefined {
  if (method === "GET" || method === "HEAD") {
    return undefined
  }
  if (req.body != null) {
    return req.body
  }
  return typeof req[Symbol.asyncIterator] === "function" ? req as RequestInit["body"] : undefined
}

export function toFetchRequest(event: H3Event): Request {
  const candidate = event.req as unknown
  if (candidate instanceof Request) {
    return candidate
  }

  const req = event.req as RequestLike
  const method = (req.method || "GET").toUpperCase()
  const headers = normalizeHeaders(req.headers)
  const init: RequestInitWithDuplex = { headers, method }
  const body = getRequestBody(method, req)
  if (body) {
    init.body = body
    init.duplex = "half"
  }
  return new Request(getRequestURL(event, req, headers), init)
}

function resolveRegistryModule(module: AgentRegistryModule): AgentInput<NitroAgentRuntimeContext> {
  return typeof module === "object" && module !== null && "default" in module
    ? module.default as AgentInput<NitroAgentRuntimeContext>
    : module as AgentInput<NitroAgentRuntimeContext>
}

function hasAgentDefinition(value: unknown): value is { capabilities?: AgentCapabilityDefinition[], resolve: (...args: unknown[]) => unknown } {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function agentCapabilityOptions(agent: AgentInput<NitroAgentRuntimeContext>): AgentCapabilityDefinition[] {
  if (!hasAgentDefinition(agent)) return []
  const workspaceDefinition = agent as Partial<WorkspaceAgentDefinition>
  const workspaceOptions = workspaceDefinition.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions | undefined
  return normalizeCapabilities(workspaceOptions?.capabilities || agent.capabilities || [])
}

function hasCustomRun(agent: AgentInput<NitroAgentRuntimeContext>): boolean {
  return typeof agent === "object" && agent !== null && "run" in agent && typeof agent.run === "function"
}

function createHookRunner<TContext extends AgentRuntimeContext>(hooks: AgentRuntimeHooks<TContext> | undefined) {
  return {
    async error(error: unknown, context: TContext) {
      await hooks?.error?.(error, context)
    },
    async request(context: TContext) {
      await hooks?.request?.(context)
    },
    async resolved(context: TContext & { agent: Awaited<ReturnType<typeof resolveAgent>> }) {
      await hooks?.resolved?.(context)
    },
  }
}

function isStreamResult(value: unknown): value is { toUIMessageStreamResponse?: () => Response, toTextStreamResponse?: () => Response } {
  return typeof value === "object"
    && value !== null
    && (typeof (value as { toUIMessageStreamResponse?: unknown }).toUIMessageStreamResponse === "function"
      || typeof (value as { toTextStreamResponse?: unknown }).toTextStreamResponse === "function")
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return !!value && typeof value === "object" && Symbol.asyncIterator in value
}

function toEventStreamResponse(stream: AsyncIterable<unknown>): Response {
  const encoder = new TextEncoder()
  return new Response(new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        }
        controller.close()
      }
      catch (error) {
        controller.error(error)
      }
    },
  }), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  })
}

function toJsonSafeResult(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return value
  }

  const result = value as Record<string, unknown>
  return {
    finishReason: result.finishReason,
    raw: result.raw,
    text: result.text,
    usage: result.usage,
    usageRecord: result.usageRecord,
    warnings: result.warnings,
  }
}

function toResponse(value: unknown, stream: boolean): unknown {
  if (value instanceof Response) {
    return value
  }

  if (stream && isStreamResult(value)) {
    if (value.toUIMessageStreamResponse) {
      return value.toUIMessageStreamResponse()
    }
    return value.toTextStreamResponse?.()
  }
  if (stream && isAsyncIterable(value)) {
    return toEventStreamResponse(value)
  }

  return toJsonSafeResult(value)
}

function createRuntimeContext(event: H3Event): NitroAgentRuntimeContext {
  const runtimeConfig = getAgentRuntimeConfig(event) as NitroAgentRuntimeConfig
  return createAgentRuntimeContext({
    event,
    request: toFetchRequest(event),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: task => event.waitUntil(task),
  }) as NitroAgentRuntimeContext
}

function createCallbackContext(context: NitroAgentRuntimeContext) {
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = context
  return callbackContext
}

function createChatStateKeyPrefix(agentName: string): string {
  const normalized = agentName
    .trim()
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
  return `_vitehub_${normalized || "agent"}_chat`
}

function namespaceChatState(state: StateAdapter, keyPrefix: string): StateAdapter {
  const prefix = `${keyPrefix}:`
  const key = (value: string) => `${prefix}${value}`
  const lock = (value: Lock): Lock => ({ ...value, threadId: key(value.threadId) })
  const unlock = (value: Lock): Lock => ({
    ...value,
    threadId: value.threadId.startsWith(prefix) ? value.threadId.slice(prefix.length) : value.threadId,
  })

  return {
    async acquireLock(threadId, ttlMs) {
      const acquired = await state.acquireLock(key(threadId), ttlMs)
      return acquired ? unlock(acquired) : null
    },
    async appendToList(listKey, value, options) {
      await state.appendToList(key(listKey), value, options)
    },
    async connect() {
      await state.connect()
    },
    async delete(cacheKey) {
      await state.delete(key(cacheKey))
    },
    async dequeue(threadId) {
      return await state.dequeue(key(threadId))
    },
    async disconnect() {
      await state.disconnect()
    },
    async enqueue(threadId, entry, maxSize) {
      return await state.enqueue(key(threadId), entry, maxSize)
    },
    async extendLock(lockValue, ttlMs) {
      return await state.extendLock(lock(lockValue), ttlMs)
    },
    async forceReleaseLock(threadId) {
      await state.forceReleaseLock(key(threadId))
    },
    async get(cacheKey) {
      return await state.get(key(cacheKey))
    },
    async getList(listKey) {
      return await state.getList(key(listKey))
    },
    async isSubscribed(threadId) {
      return await state.isSubscribed(key(threadId))
    },
    async queueDepth(threadId) {
      return await state.queueDepth(key(threadId))
    },
    async releaseLock(lockValue) {
      await state.releaseLock(lock(lockValue))
    },
    async set(cacheKey, value, ttlMs) {
      await state.set(key(cacheKey), value, ttlMs)
    },
    async setIfNotExists(cacheKey, value, ttlMs) {
      return await state.setIfNotExists(key(cacheKey), value, ttlMs)
    },
    async subscribe(threadId) {
      await state.subscribe(key(threadId))
    },
    async unsubscribe(threadId) {
      await state.unsubscribe(key(threadId))
    },
  }
}

function isResolvable<T>(value: unknown): value is { resolve: (context: NitroAgentRuntimeContext) => MaybePromise<T> } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

async function resolveValue<T>(value: unknown, context: NitroAgentRuntimeContext): Promise<T> {
  const callbackContext = createCallbackContext(context)
  if (typeof value === "function") {
    return await (value as (context: typeof callbackContext) => MaybePromise<T>)(callbackContext)
  }
  if (isResolvable<T>(value)) {
    return await value.resolve(callbackContext as never)
  }
  return value as T
}

async function resolveChatAdapters(options: AgentChatOptions, context: NitroAgentRuntimeContext): Promise<Record<string, Adapter>> {
  if (!options.adapters) {
    throw new Error("[vitehub] chat() webhook handling requires chat({ adapters }).")
  }

  const input = await resolveValue<Record<string, unknown>>(options.adapters, context)
  const adapters: Record<string, Adapter> = {}
  for (const [name, adapter] of Object.entries(input || {})) {
    adapters[name] = await resolveValue<Adapter>(adapter, context)
  }
  return adapters
}

async function resolveChatState(options: AgentChatOptions, context: NitroAgentRuntimeContext, agentName: string): Promise<StateAdapter> {
  if (options.state) {
    const existing = configuredChatStates.get(options)
    if (existing) return existing
    const stateContext = {
      ...context,
      chat: {
        agentName,
        stateKeyPrefix: createChatStateKeyPrefix(agentName),
      },
    } as NitroAgentRuntimeContext & { chat: { agentName: string, stateKeyPrefix: string } }
    const state = namespaceChatState(await resolveValue<StateAdapter>(options.state, stateContext), stateContext.chat.stateKeyPrefix)
    configuredChatStates.set(options, state)
    return state
  }
  return getDefaultChatState(options)
}

function createChatSdkOptions(options: AgentChatOptions, adapters: Record<string, Adapter>, state: StateAdapter, agentName: string): ChatConfig<Record<string, Adapter>> {
  const {
    adapters: _adapters,
    agent: _agent,
    event: _event,
    execution: _execution,
    fallbackStreamingPlaceholderText: _fallbackStreamingPlaceholderText,
    hooks: _hooks,
    lifecycleHooks: _lifecycleHooks,
    state: _state,
    userName,
    webhooks: _webhooks,
    workflow: _workflow,
    ...chatOptions
  } = options as AgentChatOptions & { userName?: string }

  return {
    ...(chatOptions as ChatConfigRecord),
    adapters,
    fallbackStreamingPlaceholderText: null,
    state,
    userName: typeof userName === "string" && userName ? userName : agentName,
  }
}

function entityId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "id" in value && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id
    : undefined
}

function messageCreatedAt(message: ChatMessage): Date | string | undefined {
  const dateSent = (message as { metadata?: { dateSent?: unknown } }).metadata?.dateSent
  return dateSent instanceof Date || typeof dateSent === "string" ? dateSent : undefined
}

function attachmentMediaType(attachment: Attachment): string {
  return attachment.mimeType?.startsWith("audio/") ? attachment.mimeType : "audio/ogg"
}

async function attachmentData(attachment: Attachment): Promise<unknown> {
  if (attachment.data) return attachment.data
  if (attachment.fetchData) return await attachment.fetchData()
}

async function audioAttachmentPart(attachment: Attachment, index: number): Promise<Record<string, unknown> | undefined> {
  if (attachment.type !== "audio") return
  const mediaType = attachmentMediaType(attachment)
  const id = attachment.name || `audio-${index + 1}`
  const data = await attachmentData(attachment)
  if (data) return { data, id, mediaType, type: "audio" }
  if (attachment.url) return { id, mediaType, type: "audio", url: attachment.url }
}

async function toUIMessage(message: ChatMessage, index: number) {
  const attachments = (await Promise.all((message.attachments || []).map(audioAttachmentPart)))
    .filter((part): part is Record<string, unknown> => Boolean(part))
  const text = typeof message.text === "string" ? message.text : ""
  return {
    createdAt: messageCreatedAt(message),
    id: entityId(message) || `chat-message-${index}`,
    metadata: { source: "chat" },
    parts: [
      ...(text ? [{ text, type: "text" }] : []),
      ...attachments,
    ],
    role: (message as { author?: { isMe?: boolean } }).author?.isMe ? "assistant" : "user",
  }
}

function normalizeChatHistory(history: AgentChatOptions["history"]): { enabled: boolean, maxMessages: number } {
  if (history === false || history === "none") {
    return { enabled: false, maxMessages: 0 }
  }
  if (typeof history === "object" && history) {
    return { enabled: true, maxMessages: history.maxMessages ?? 20 }
  }
  return { enabled: true, maxMessages: 20 }
}

function sameMessage(left: ChatMessage | undefined, right: ChatMessage): boolean {
  const leftId = entityId(left)
  const rightId = entityId(right)
  return !!leftId && !!rightId && leftId === rightId
}

async function collectThreadMessages(thread: Thread, message: ChatMessage, history: AgentChatOptions["history"]): Promise<ChatMessage[]> {
  const options = normalizeChatHistory(history)
  if (!options.enabled || options.maxMessages <= 0) {
    return [message]
  }

  const result = await thread.adapter.fetchMessages(thread.id, {
    direction: "backward",
    limit: options.maxMessages,
  })
  const messages = [...result.messages]
  if (!messages.length || !sameMessage(messages.at(-1), message)) {
    messages.push(message)
  }
  return messages.slice(-options.maxMessages)
}

function createRunMetadata(platform: string, thread: Thread, channel: Channel | undefined, message: ChatMessage): AgentRunMetadata {
  return {
    channelId: entityId(channel) || thread.channelId,
    messageId: entityId(message),
    platform,
    runId: globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    threadId: entityId(thread) || thread.id,
  }
}

async function* textStreamFromEvents(stream: AsyncIterable<unknown>): AsyncIterable<string> {
  for await (const event of stream) {
    if (typeof event === "string") {
      yield event
      continue
    }
    if (event && typeof event === "object" && "type" in event && (event as { type?: unknown }).type === "text-delta") {
      const text = (event as { delta?: unknown, text?: unknown }).text ?? (event as { delta?: unknown }).delta
      if (typeof text === "string" && text) yield text
    }
  }
}

async function collectStreamText(stream: AsyncIterable<unknown>): Promise<string> {
  let text = ""
  for await (const chunk of textStreamFromEvents(stream)) {
    text += chunk
  }
  return text
}

async function postAgentResult(thread: Thread, result: unknown, placeholder?: SentMessage): Promise<void> {
  if (placeholder) {
    const final = isAsyncIterable(result)
      ? await collectStreamText(result)
      : result instanceof Response
        ? await result.clone().text()
        : result
    await placeholder.edit((final || " ") as never)
    return
  }

  if (isAsyncIterable(result)) {
    await thread.post(textStreamFromEvents(result) as never)
    return
  }
  if (result instanceof Response) {
    await thread.post(await result.clone().text())
    return
  }
  await thread.post(result as never)
}

async function handleChatMessage(
  agent: AgentInput<NitroAgentRuntimeContext>,
  context: NitroAgentRuntimeContext,
  platform: string,
  options: AgentChatOptions,
  thread: Thread,
  message: ChatMessage,
  channel?: Channel,
): Promise<void> {
  let placeholderPromise: Promise<SentMessage | undefined> | undefined = typeof options.fallbackStreamingPlaceholderText === "string"
    ? thread.post(options.fallbackStreamingPlaceholderText).catch(() => undefined) as Promise<SentMessage | undefined>
    : undefined
  const sourceMessages = await collectThreadMessages(thread, message, options.history)
  const messages = await Promise.all(sourceMessages.map(toUIMessage))
  const run = createRunMetadata(platform, thread, channel, message)
  let thinkingFallback: string | undefined
  const triggerInput: AgentChatMessageTriggerInput = {
    history: options.history,
    messages,
    run,
    timeout: 90_000,
    user: {
      id: message.author?.userId,
      name: message.author?.userName,
    },
  }
  const result = await streamAgentTrigger(agent, { ...context, run } as never, "chat.message", triggerInput, {
    output: "events",
    async onInvocation(invocation) {
      thinkingFallback = typeof invocation.metadata?.thinkingFallback === "string"
        ? invocation.metadata.thinkingFallback
        : undefined
      placeholderPromise ||= thinkingFallback
        ? thread.post(thinkingFallback).catch(() => undefined) as Promise<SentMessage | undefined>
        : undefined
      await placeholderPromise
    },
  })
  const placeholder = placeholderPromise ? await placeholderPromise : undefined
  await postAgentResult(thread, result, placeholder)
}

async function runDirectMessageHook(
  options: AgentChatOptions,
  platform: string,
  thread: Thread,
  message: ChatMessage,
  channel?: Channel,
): Promise<void> {
  await options.hooks?.onDirectMessage?.({
    channel: { id: entityId(channel) || thread.channelId },
    message: { text: typeof message.text === "string" ? message.text : "" },
    platform,
    thread: { id: entityId(thread) || thread.id },
  })
}

async function createAgentChatBot(agent: AgentInput<NitroAgentRuntimeContext>, context: NitroAgentRuntimeContext, agentName: string, platform: string): Promise<Chat<Record<string, Adapter>>> {
  const triggers = await resolveAgentTriggers(agent, context)
  if (!triggers["chat.message"]) {
    throw createError({
      statusCode: 404,
      statusMessage: `Agent "${agentName}" does not define chat.message.`,
    })
  }

  const options = getChatCapabilityOptions(agentCapabilityOptions(agent))
  if (!options) {
    throw createError({
      statusCode: 404,
      statusMessage: `Agent "${agentName}" does not define chat().`,
    })
  }

  const adapters = await resolveChatAdapters(options, context)
  if (!adapters[platform]) {
    throw createError({
      statusCode: 404,
      statusMessage: `Agent "${agentName}" does not define a "${platform}" chat adapter.`,
    })
  }

  const state = await resolveChatState(options, context, agentName)
  const bot = new Chat(createChatSdkOptions(options, adapters, state, agentName))
  bot.onDirectMessage(async (thread, message, channel) => {
    await runDirectMessageHook(options, platform, thread, message, channel)
    await handleChatMessage(agent, context, platform, options, thread, message, channel)
  })
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe().catch(() => undefined)
    await handleChatMessage(agent, context, platform, options, thread, message, thread.channel)
  })
  bot.onSubscribedMessage((thread, message) => handleChatMessage(agent, context, platform, options, thread, message, thread.channel))
  return bot
}

async function readAgentBody(request: Request): Promise<AgentRequestBody> {
  const body = await request.clone().json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentRequestBody : {}
}

export function defineAgentHandler(
  agent: AgentInput<NitroAgentRuntimeContext>,
  options: AgentHandlerOptions<NitroAgentRuntimeContext> = {},
): EventHandler {
  const hooks = createHookRunner(options.lifecycleHooks)

  return defineEventHandler(async (event) => {
    const context = createRuntimeContext(event)
    try {
      await hooks.request(context)

      const body = await readAgentBody(context.request!)
      const stream = body.stream !== false
      if (options.lifecycleHooks?.resolved && !hasCustomRun(agent)) {
        const resolved = await resolveAgent(agent, context)
        await hooks.resolved({ ...context, agent: resolved })
      }
      const result = stream
        ? await streamAgent(agent, context, body)
        : await runAgent(agent, context, body)

      return toResponse(result, stream)
    }
    catch (error) {
      await hooks.error(error, context).catch(() => undefined)
      const statusCode = getHttpErrorStatusCode(error)
      if (statusCode) {
        throw createError({
          statusCode,
          statusMessage: getHttpErrorMessage(error),
        })
      }
      throw error
    }
  })
}

export function defineAgentRegistryHandler(
  agents: AgentRegistry,
  options: AgentRegistryHandlerOptions<NitroAgentRuntimeContext> = {},
): EventHandler {
  const agentParam = options.agentParam || "agent"

  return defineEventHandler(async (event) => {
    const agentName = getRouterParam(event, agentParam)
    if (!agentName) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing agent route param: ${agentParam}`,
      })
    }

    const loader = agents[agentName]
    if (!loader) {
      throw createError({
        statusCode: 404,
        statusMessage: formatUnknownAgentMessage(agentName, Object.keys(agents).sort()),
      })
    }

    const agent = resolveRegistryModule(await loader())
    return await defineAgentHandler(agent, options)(event)
  })
}

export function defineAgentChatWebhookRegistryHandler(
  agents: AgentRegistry,
  options: AgentChatWebhookRegistryHandlerOptions = {},
): EventHandler {
  const agentParam = options.agentParam || "agent"
  const platformParam = options.platformParam || "platform"

  return defineEventHandler(async (event) => {
    const agentName = getRouterParam(event, agentParam)
    if (!agentName) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing agent route param: ${agentParam}`,
      })
    }

    const platform = options.platform || getRouterParam(event, platformParam)
    if (!platform) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing chat platform route param: ${platformParam}`,
      })
    }

    const loader = agents[agentName]
    if (!loader) {
      throw createError({
        statusCode: 404,
        statusMessage: formatUnknownAgentMessage(agentName, Object.keys(agents).sort()),
      })
    }

    const context = createRuntimeContext(event)
    const agent = resolveRegistryModule(await loader())
    const bot = await createAgentChatBot(agent, context, agentName, platform)
    const webhook = (bot.webhooks as Record<string, ((request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => Promise<Response>) | undefined>)[platform]
    if (!webhook) {
      throw createError({
        statusCode: 404,
        statusMessage: `Unknown chat platform: ${platform}`,
      })
    }
    return await webhook(context.request!, { waitUntil: task => event.waitUntil(task) })
  })
}
