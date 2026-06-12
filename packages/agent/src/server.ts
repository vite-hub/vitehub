import { createRuntimeWaitUntilController } from "@vite-hub/runtime"
import { Chat } from "chat"

import { resolveAgentTriggerInvocation, resolveAgentTriggers, runAgentInline, streamAgent, streamAgentTrigger } from "./index.ts"
import { streamAgentOutputToEvents } from "./agent-output.ts"
import { getAccessCapabilityOptions } from "./capabilities/access.ts"
import { formatUsageTelemetryChatMessage, getUsageTelemetryChatOptions } from "./capabilities/usage-telemetry.ts"
import { CHAT_FINISH_EXTENSION_CONTEXT_KEY, getChatCapabilityOptions } from "./chat-trigger.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"
import { toHttpErrorResponse } from "./http-error.ts"

import type { AgentChatMessageTriggerInput } from "./chat-trigger.ts"
import type {
  AgentChatStateResolver,
  AgentCapabilityDefinition,
  AgentChatFinishExtension,
  AgentChatMessage,
  AgentChatOptions,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeName,
  AgentWaitUntil,
  AgentWebhookRegistrationDefinition,
  AgentUsageRecord,
  MaybeResolvable,
} from "./types.ts"
import type { AccessChatIdentity } from "./capabilities/access.ts"
import type { UsageTelemetryChatCallbackContext, UsageTelemetryChatMessage } from "./capabilities/usage-telemetry.ts"
import type { AudioData, MessagePart } from "./messages.ts"
import type { Adapter, Attachment, ChatConfig, Lock, Message as ChatSdkMessage, MessageContext, QueueEntry, StateAdapter, Thread, WebhookOptions } from "chat"

interface ViteAgentRouteRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

interface ViteAgentRouteRuntimeContext extends AgentRuntimeContext<ViteAgentRouteRuntimeConfig> {
  request: Request
  runtime: AgentRuntimeName
  runtimeConfig: ViteAgentRouteRuntimeConfig
}

type AgentChatRouteBody = AgentChatMessageTriggerInput & {
  stream?: boolean
}

export interface AgentChatFetchOptions {
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"]
  waitUntil?: AgentWaitUntil
}

export interface AgentChatWebhookFetchOptions extends AgentChatFetchOptions {
  agentName?: string
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
}

type AgentDefinitionWithCapabilities = {
  __vitehubWorkspaceAgentOptions?: {
    capabilities?: AgentCapabilityDefinition[]
  }
  capabilities?: AgentCapabilityDefinition[]
  chat?: AgentChatOptions
}

async function readJsonBody(request: Request): Promise<AgentChatRouteBody> {
  const body = await request.json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentChatRouteBody : { messages: [] }
}

function chatAppRouteTriggerInput(body: AgentChatRouteBody): AgentChatMessageTriggerInput {
  return {
    ...(body.history !== undefined ? { history: body.history } : {}),
    messages: body.messages,
    ...(body.session !== undefined ? { session: body.session } : {}),
    ...(body.timeout !== undefined ? { timeout: body.timeout } : {}),
  }
}

function readableStreamFromResult(value: unknown): ReadableStream<unknown> {
  if (value instanceof ReadableStream) return value
  if (value instanceof Response && value.body) return value.body
  throw new Error("[vitehub] Agent chat route expected a UI message stream.")
}

function createJsonErrorResponse(status: number, message: string): Response {
  return Response.json({
    error: true,
    status,
    statusText: message,
    message,
  }, { status })
}

function createBadRequest(message: string): Response {
  return createJsonErrorResponse(400, message)
}

function detectRuntime(): AgentRuntimeName {
  const env = typeof process === "object" && process ? process.env : undefined
  if (env?.VERCEL) return "vercel"
  return "vite"
}

function createRuntimeContext(
  request: Request,
  run: AgentRunMetadata | undefined,
  waitUntil?: AgentWaitUntil,
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"],
): ViteAgentRouteRuntimeContext {
  const waitUntilController = createRuntimeWaitUntilController({ forward: waitUntil })
  const runtime = cloudflare ? "cloudflare-agents" : detectRuntime()
  return createAgentRuntimeContext({
    ...(cloudflare ? { cloudflare } : {}),
    flushWaitUntil: waitUntilController.flushWaitUntil,
    request,
    ...(run ? { run } : {}),
    runtime,
    runtimeConfig: {},
    ...(runtime === "vercel" && waitUntil ? { vercel: { waitUntil } } : {}),
    waitUntil: waitUntilController.waitUntil,
  }) as ViteAgentRouteRuntimeContext
}

async function resolveRuntimeWaitUntil(waitUntil: AgentWaitUntil | undefined): Promise<AgentWaitUntil | undefined> {
  if (detectRuntime() !== "vercel") return waitUntil
  const vercel = await import("@vercel/functions").catch(() => undefined) as { waitUntil?: AgentWaitUntil } | undefined
  return vercel?.waitUntil || waitUntil
}

async function toUiMessageStreamResponse(stream: ReadableStream<unknown>): Promise<Response> {
  const { createUIMessageStreamResponse } = await import("ai") as {
    createUIMessageStreamResponse: (options: { stream: ReadableStream<unknown> }) => Response
  }
  return createUIMessageStreamResponse({ stream })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isResolvableObject<T, TContext extends AgentRuntimeContext>(
  value: unknown,
): value is { resolve: (context: TContext) => T | Promise<T> } {
  return isRecord(value) && typeof value.resolve === "function"
}

async function resolveMaybe<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext> | undefined,
  context: TContext,
): Promise<T | undefined> {
  if (value === undefined) return undefined
  if (typeof value === "function") {
    return await (value as (context: TContext) => T | Promise<T>)(context)
  }
  if (isResolvableObject<T, TContext>(value)) {
    return await value.resolve(context)
  }
  return value as T
}

function getAgentCapabilities(agent: unknown): AgentCapabilityDefinition[] {
  if (!isRecord(agent)) return []
  const definition = agent as AgentDefinitionWithCapabilities
  return definition.__vitehubWorkspaceAgentOptions?.capabilities || definition.capabilities || []
}

function getAgentChatOptions(agent: unknown): AgentChatOptions | undefined {
  if (!isRecord(agent)) return undefined
  const definition = agent as AgentDefinitionWithCapabilities
  return getChatCapabilityOptions(getAgentCapabilities(agent)) || definition.chat
}

async function findChatWebhookRegistration(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  webhook: string,
): Promise<AgentWebhookRegistrationDefinition | undefined> {
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  const registrations = triggers["chat.message"]?.webhooks || []
  return registrations.find(registration => registration.id === webhook || registration.provider === webhook)
}

async function resolveChatAdapters(
  options: AgentChatOptions | undefined,
  context: ViteAgentRouteRuntimeContext,
): Promise<Record<string, Adapter>> {
  const adapters = await resolveMaybe(
    options?.adapters as MaybeResolvable<Record<string, MaybeResolvable<Adapter, ViteAgentRouteRuntimeContext>>, ViteAgentRouteRuntimeContext> | undefined,
    context,
  )
  const resolved: Record<string, Adapter> = {}
  for (const [name, adapter] of Object.entries(adapters || {})) {
    const value = await resolveMaybe(adapter, context)
    if (value) resolved[name] = value
  }
  return resolved
}

function resolveChatAdapterName(adapters: Record<string, Adapter>, registration: AgentWebhookRegistrationDefinition): string | undefined {
  if (adapters[registration.provider]) return registration.provider
  if (registration.id && adapters[registration.id]) return registration.id
  return undefined
}

function objectWithoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function fallbackWebhookFromRequest(request: Request): string | undefined {
  return new URL(request.url).pathname.split("/").filter(Boolean).at(-1) || undefined
}

interface CollectedAgentOutput {
  text: string
  usageRecord?: AgentUsageRecord
}

async function collectAgentOutput(result: unknown): Promise<CollectedAgentOutput> {
  if (result instanceof Response) {
    if (result.headers.get("content-type")?.includes("application/json")) {
      const body = await result.clone().json().catch(() => undefined)
      if (isRecord(body) && typeof body.text === "string") {
        return {
          text: body.text,
          ...(isRecord(body.usageRecord) ? { usageRecord: body.usageRecord as AgentUsageRecord } : {}),
        }
      }
    }
    return { text: await result.text() }
  }

  let text = ""
  let usageRecord: AgentUsageRecord | undefined
  for await (const event of streamAgentOutputToEvents(result)) {
    if (event.type === "text-delta") {
      text += event.text
    }
    if (event.type === "usage") {
      usageRecord = event.usageRecord
    }
    if (event.type === "error") {
      throw new Error(event.error)
    }
  }
  return {
    ...(usageRecord ? { usageRecord } : {}),
    text: text.trim(),
  }
}

function streamAgentOutputToChatText(
  result: Promise<unknown>,
  onUsageRecord: (usageRecord: AgentUsageRecord) => void,
): AsyncIterable<string> {
  return {
    async *[Symbol.asyncIterator]() {
      const output = await result
      if (output instanceof Response) {
        if (output.headers.get("content-type")?.includes("application/json")) {
          const body = await output.clone().json().catch(() => undefined)
          if (isRecord(body)) {
            if (isRecord(body.usageRecord)) onUsageRecord(body.usageRecord as AgentUsageRecord)
            if (typeof body.text === "string") yield body.text
            return
          }
        }
        yield await output.text()
        return
      }

      for await (const event of streamAgentOutputToEvents(output)) {
        if (event.type === "text-delta") {
          yield event.text
        }
        if (event.type === "usage") {
          onUsageRecord(event.usageRecord)
        }
        if (event.type === "error") {
          throw new Error(event.error)
        }
      }
    },
  }
}

function randomToken(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isExpired(expiresAt: number | null | undefined): boolean {
  return typeof expiresAt === "number" && expiresAt <= Date.now()
}

class ViteHubInMemoryChatStateAdapter implements StateAdapter {
  private cache = new Map<string, { expiresAt?: number, value: unknown }>()
  private connected = false
  private lists = new Map<string, Array<{ expiresAt?: number, value: unknown }>>()
  private locks = new Map<string, Lock>()
  private queues = new Map<string, QueueEntry[]>()
  private subscriptions = new Set<string>()

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    this.ensureConnected()
    const existing = this.locks.get(threadId)
    if (existing && !isExpired(existing.expiresAt)) return null
    const lock = { expiresAt: Date.now() + ttlMs, threadId, token: randomToken() }
    this.locks.set(threadId, lock)
    return lock
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number, ttlMs?: number }): Promise<void> {
    this.ensureConnected()
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : undefined
    const list = (this.lists.get(key) || []).filter(item => !isExpired(item.expiresAt))
    list.push({ expiresAt, value })
    if (options?.maxLength && options.maxLength > 0) {
      this.lists.set(key, list.slice(-options.maxLength))
      return
    }
    this.lists.set(key, list)
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async delete(key: string): Promise<void> {
    this.ensureConnected()
    this.cache.delete(key)
    this.lists.delete(key)
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected()
    const queue = (this.queues.get(threadId) || []).filter(entry => !isExpired(entry.expiresAt))
    const entry = queue.shift() || null
    this.queues.set(threadId, queue)
    return entry
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    this.ensureConnected()
    const queue = (this.queues.get(threadId) || []).filter(item => !isExpired(item.expiresAt))
    queue.push(entry)
    const trimmed = maxSize > 0 ? queue.slice(-maxSize) : queue
    this.queues.set(threadId, trimmed)
    return trimmed.length
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    this.ensureConnected()
    const existing = this.locks.get(lock.threadId)
    if (!existing || existing.token !== lock.token || isExpired(existing.expiresAt)) return false
    existing.expiresAt = Date.now() + ttlMs
    return true
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.ensureConnected()
    this.locks.delete(threadId)
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    this.ensureConnected()
    const item = this.cache.get(key)
    if (!item || isExpired(item.expiresAt)) {
      this.cache.delete(key)
      return null
    }
    return item.value as T
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    this.ensureConnected()
    const list = (this.lists.get(key) || []).filter(item => !isExpired(item.expiresAt))
    this.lists.set(key, list)
    return list.map(item => item.value as T)
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected()
    return this.subscriptions.has(threadId)
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected()
    const queue = (this.queues.get(threadId) || []).filter(entry => !isExpired(entry.expiresAt))
    this.queues.set(threadId, queue)
    return queue.length
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.ensureConnected()
    const existing = this.locks.get(lock.threadId)
    if (existing?.token === lock.token) this.locks.delete(lock.threadId)
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.ensureConnected()
    this.cache.set(key, { expiresAt: ttlMs ? Date.now() + ttlMs : undefined, value })
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    this.ensureConnected()
    const existing = this.cache.get(key)
    if (existing && !isExpired(existing.expiresAt)) return false
    this.cache.set(key, { expiresAt: ttlMs ? Date.now() + ttlMs : undefined, value })
    return true
  }

  async subscribe(threadId: string): Promise<void> {
    this.ensureConnected()
    this.subscriptions.add(threadId)
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.ensureConnected()
    this.subscriptions.delete(threadId)
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("[vitehub] In-memory Chat State is not connected. Call connect() before using state.")
    }
  }
}

const inMemoryChatStates = new Map<string, StateAdapter>()

function getInMemoryChatState(key: string): StateAdapter {
  let state = inMemoryChatStates.get(key)
  if (!state) {
    state = new ViteHubInMemoryChatStateAdapter()
    inMemoryChatStates.set(key, state)
  }
  return state
}

async function resolveChatState(
  options: AgentChatOptions | undefined,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  handlerOptions: AgentChatWebhookFetchOptions,
): Promise<StateAdapter> {
  const agentName = handlerOptions.agentName || "agent"
  const state = await resolveMaybe(
    (options?.state ?? handlerOptions.state) as AgentChatStateResolver<ViteAgentRouteRuntimeConfig> | undefined,
    {
      ...context,
      chat: {
        agentName,
        stateKeyPrefix: `chat:${agentName}:${registration.provider}:`,
      },
    } as never,
  )
  return state || getInMemoryChatState(`${agentName}:${registration.provider}`)
}

function chatSdkOption<T>(options: AgentChatOptions | undefined, key: string): T | undefined {
  return isRecord(options) ? options[key] as T | undefined : undefined
}

function createChatSdkConfig(
  adapters: Record<string, Adapter>,
  state: StateAdapter,
  options: AgentChatOptions | undefined,
): ChatConfig {
  const fallbackStreamingPlaceholderText = typeof options?.fallbackStreamingPlaceholderText === "function"
    ? undefined
    : options?.fallbackStreamingPlaceholderText
  return objectWithoutUndefined({
    adapters,
    concurrency: chatSdkOption<ChatConfig["concurrency"]>(options, "concurrency"),
    dedupeTtlMs: chatSdkOption<number>(options, "dedupeTtlMs"),
    fallbackStreamingPlaceholderText,
    identity: options?.identity,
    lockScope: chatSdkOption<ChatConfig["lockScope"]>(options, "lockScope"),
    logger: chatSdkOption<ChatConfig["logger"]>(options, "logger"),
    messageHistory: chatSdkOption<ChatConfig["messageHistory"]>(options, "messageHistory"),
    state,
    streamingUpdateIntervalMs: chatSdkOption<number>(options, "streamingUpdateIntervalMs"),
    threadHistory: chatSdkOption<ChatConfig["threadHistory"]>(options, "threadHistory"),
    transcripts: options?.transcripts,
    userName: options?.userName || "vitehub",
  }) as ChatConfig
}

function isoDate(value: unknown): string | undefined {
  return value instanceof Date ? value.toISOString() : undefined
}

function accessChatIdentity(provider: string, message: ChatSdkMessage): AccessChatIdentity {
  return objectWithoutUndefined({
    id: message.author.userId,
    metadata: objectWithoutUndefined({
      isBot: message.author.isBot,
      isMe: message.author.isMe,
      userKey: message.userKey,
    }),
    name: message.author.fullName,
    provider,
    username: message.author.userName,
  })
}

function audioData(value: unknown): AudioData | undefined {
  if (typeof value === "string") return value
  if (value instanceof ArrayBuffer) return value
  if (value instanceof Blob) return value
  if (value instanceof Uint8Array) return value
  return undefined
}

function audioPartFromAttachment(attachment: Attachment, index: number): MessagePart | undefined {
  if (attachment.type !== "audio") return undefined
  const mediaType = typeof attachment.mimeType === "string" && attachment.mimeType.startsWith("audio/")
    ? attachment.mimeType
    : "audio/ogg"
  const base = objectWithoutUndefined({
    fetchMetadata: attachment.fetchMetadata,
    id: `audio-${index + 1}`,
    mediaType,
    name: attachment.name,
    size: attachment.size,
    type: "audio" as const,
  })
  if (typeof attachment.fetchData === "function") {
    return {
      ...base,
      fetchData: async () => {
        const data = audioData(await attachment.fetchData?.())
        if (!data) {
          throw new Error("[vitehub] Chat attachment fetchData() did not return supported audio data.")
        }
        return data
      },
    }
  }
  if (typeof attachment.url === "string" && attachment.url) {
    return { ...base, url: attachment.url }
  }
  const data = audioData(attachment.data)
  if (data) {
    return { ...base, data }
  }
  return undefined
}

function chatMessageParts(message: ChatSdkMessage): MessagePart[] {
  const parts: MessagePart[] = []
  if (message.text) {
    parts.push({ id: "text-0", text: message.text, type: "text" })
  }
  for (const [index, attachment] of message.attachments.entries()) {
    const part = audioPartFromAttachment(attachment, index)
    if (part) parts.push(part)
  }
  return parts
}

function createChatTriggerInput(
  provider: string,
  thread: Thread,
  message: ChatSdkMessage,
  messageContext?: MessageContext,
): AgentChatMessageTriggerInput {
  const metadata = objectWithoutUndefined({
    chat: objectWithoutUndefined({
      edited: message.metadata.edited,
      editedAt: isoDate(message.metadata.editedAt),
      isMention: message.isMention,
      messageId: message.id,
      skippedCount: messageContext?.skipped.length,
      threadId: message.threadId,
      totalSinceLastHandler: messageContext?.totalSinceLastHandler,
    }),
  })
  const user = objectWithoutUndefined({
    id: message.author.userId,
    isBot: message.author.isBot,
    isMe: message.author.isMe,
    name: message.author.fullName,
    username: message.author.userName,
  })
  return {
    messages: [{
      createdAt: isoDate(message.metadata.dateSent),
      id: message.id,
      metadata,
      parts: chatMessageParts(message),
      role: "user",
    }],
    run: {
      channelId: thread.adapter.channelIdFromThreadId(message.threadId),
      messageId: message.id,
      origin: provider,
      runId: `${provider}:${message.id}`,
      threadId: message.threadId,
    },
    user,
  }
}

function accessChatInput(thread: Thread, message: ChatSdkMessage, messageContext?: MessageContext): Record<string, unknown> {
  return {
    message: objectWithoutUndefined({
      attachmentCount: message.attachments.length,
      id: message.id,
      isMention: message.isMention,
      text: message.text,
      threadId: message.threadId,
    }),
    queue: objectWithoutUndefined({
      skippedCount: messageContext?.skipped.length,
      totalSinceLastHandler: messageContext?.totalSinceLastHandler,
    }),
    thread: {
      id: thread.id,
      isDM: thread.isDM,
    },
  }
}

function isTextChatMessage(message: AgentChatMessage): message is { text: string } {
  return typeof message === "object"
    && message !== null
    && "text" in message
    && typeof message.text === "string"
}

async function postChatMessage(thread: Thread, message: AgentChatMessage): Promise<void> {
  await thread.post(isTextChatMessage(message) ? message.text : message)
}

function createChatFinishExtension(
  input: AgentChatMessageTriggerInput,
  registration: AgentWebhookRegistrationDefinition,
  thread: Thread,
): AgentChatFinishExtension {
  return {
    provider: registration.provider,
    ...(input.run ? { run: input.run } : {}),
    sendMessage: async (message) => {
      await postChatMessage(thread, message)
    },
  }
}

function withChatFinishExtension<CALL_OPTIONS>(
  input: AgentRunInput<CALL_OPTIONS>,
  chat: AgentChatFinishExtension,
): AgentRunInput<CALL_OPTIONS> {
  return {
    ...input,
    context: {
      ...(input.context || {}),
      [CHAT_FINISH_EXTENSION_CONTEXT_KEY]: chat,
    },
  }
}

async function isChatMessageAuthorized(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  thread: Thread,
  message: ChatSdkMessage,
  messageContext?: MessageContext,
): Promise<boolean> {
  for (const options of getAccessCapabilityOptions(getAgentCapabilities(agent))) {
    if (!options.chat) continue
    const result = await options.chat.resolve({
      ...context,
      identity: accessChatIdentity(registration.provider, message),
      input: accessChatInput(thread, message, messageContext),
      provider: registration.provider,
      request: context.request,
      webhook: registration,
    })
    if (result === false) return false
  }
  return true
}

async function postUsageTelemetry(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  durationMs: number,
  input: AgentChatMessageTriggerInput,
  registration: AgentWebhookRegistrationDefinition,
  thread: Thread,
  usageRecord: AgentUsageRecord | undefined,
): Promise<void> {
  if (!usageRecord) return
  for (const options of getUsageTelemetryChatOptions(getAgentCapabilities(agent))) {
    const context: UsageTelemetryChatCallbackContext = {
      durationMs,
      provider: registration.provider,
      ...(input.run ? { run: input.run } : {}),
      sendMessage: async (message: UsageTelemetryChatMessage) => {
        await postChatMessage(thread, message)
      },
    }
    if (options.onUsage) {
      await options.onUsage(usageRecord, context)
      continue
    }
    const markdown = options.format
      ? await options.format(usageRecord, context)
      : formatUsageTelemetryChatMessage(usageRecord, context)
    if (markdown) await thread.post({ markdown })
  }
}

async function handleChatSdkMessage(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  thread: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
  messageContext?: MessageContext,
): Promise<void> {
  const input = createChatTriggerInput(registration.provider, thread, message, messageContext)
  const firstMessage = input.messages[0]
  if (!firstMessage || !Array.isArray(firstMessage.parts) || firstMessage.parts.length === 0) return
  if (!await isChatMessageAuthorized(agent, context, registration, thread, message, messageContext)) return

  const startedAt = Date.now()
  if (options?.stream !== false) {
    context.waitUntil(thread.startTyping().catch(() => undefined))
  }
  const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, "chat.message", input)
  const runContext = {
    ...context,
    ...(invocation.run ? { run: invocation.run } : {}),
  }
  const invocationInput = withChatFinishExtension(
    invocation.input as AgentRunInput,
    createChatFinishExtension(input, registration, thread),
  )
  let usageRecord: AgentUsageRecord | undefined
  if (options?.stream === false) {
    const result = await runAgentInline(agent as never, runContext as never, invocationInput as never)
    const collected = await collectAgentOutput(result)
    usageRecord = collected.usageRecord
    if (collected.text) {
      await thread.post({ markdown: collected.text })
    }
  }
  else {
    const result = streamAgent(agent as never, runContext as never, invocationInput as never, {
      output: "events",
    })
    await thread.post(streamAgentOutputToChatText(result, record => {
      usageRecord = record
    }))
  }
  await postUsageTelemetry(agent, Date.now() - startedAt, input, registration, thread, usageRecord)
}

async function createChatWebhookHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  adapterName: string,
  adapter: Adapter,
  options: AgentChatOptions | undefined,
  handlerOptions: AgentChatWebhookFetchOptions,
): Promise<(request: Request, webhookOptions: WebhookOptions) => Promise<Response>> {
  const chat = new Chat(createChatSdkConfig({
    [adapterName]: adapter,
  }, await resolveChatState(options, context, registration, handlerOptions), options))

  chat.onDirectMessage((thread, message, _channel, messageContext) =>
    handleChatSdkMessage(agent, context, registration, thread, message, options, messageContext))
  chat.onNewMention(async (thread, message, messageContext) => {
    await thread.subscribe().catch(() => undefined)
    await handleChatSdkMessage(agent, context, registration, thread, message, options, messageContext)
  })
  chat.onSubscribedMessage((thread, message, messageContext) =>
    handleChatSdkMessage(agent, context, registration, thread, message, options, messageContext))

  const handler = chat.webhooks[adapterName]
  if (!handler) {
    throw new Error(`[vitehub] Chat adapter "${adapterName}" did not expose a webhook handler.`)
  }
  return handler
}

export function defineAgentChatFetchHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, options?: AgentChatFetchOptions) => Promise<Response> {
  return async (request, handlerOptions = {}) => {
    const body = await readJsonBody(request.clone())
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return createBadRequest("Agent chat route requires messages.")
    }

    try {
      const context = createRuntimeContext(
        request,
        undefined,
        await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
        handlerOptions.cloudflare,
      )
      const result = await streamAgentTrigger(agent as never, context, "chat.message", chatAppRouteTriggerInput(body), {
        output: "ui-message-stream",
      })
      return await toUiMessageStreamResponse(readableStreamFromResult(result))
    }
    catch (error) {
      const response = toHttpErrorResponse(error)
      if (response) return response
      throw error
    }
  }
}

export function defineAgentChatWebhookFetchHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, webhook?: string, options?: AgentChatWebhookFetchOptions) => Promise<Response> {
  return async (request, webhook, handlerOptions = {}) => {
    if (request.method !== "POST") {
      return createJsonErrorResponse(405, "Agent chat webhook route only accepts POST requests.")
    }

    const webhookId = webhook || fallbackWebhookFromRequest(request)
    if (!webhookId) {
      return createBadRequest("Agent chat webhook route requires a webhook id.")
    }

    const context = createRuntimeContext(
      request,
      undefined,
      await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
      handlerOptions.cloudflare,
    )
    const registration = await findChatWebhookRegistration(agent, context, webhookId)
    if (!registration) {
      return createJsonErrorResponse(404, "Unknown ViteHub agent chat webhook.")
    }

    const chatOptions = getAgentChatOptions(agent)
    const adapters = await resolveChatAdapters(chatOptions, context)
    const adapterName = resolveChatAdapterName(adapters, registration)
    const adapter = adapterName ? adapters[adapterName] : undefined
    if (!adapter) {
      return createJsonErrorResponse(500, `Agent chat webhook "${webhookId}" does not have a matching chat adapter.`)
    }

    try {
      const handler = await createChatWebhookHandler(agent, context, registration, adapterName!, adapter, chatOptions, handlerOptions)
      const response = await handler(request, { waitUntil: context.waitUntil })
      if (chatOptions?.stream === false) {
        await context.flushWaitUntil?.()
      }
      return response
    }
    catch (error) {
      const response = toHttpErrorResponse(error)
      if (response) return response
      throw error
    }
  }
}
