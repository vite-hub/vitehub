import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeWaitUntilController } from "@vite-hub/runtime"
import { Chat, StreamingPlan } from "chat"

import { createAgentDevtoolsMetadata, materializeAgentDevtoolsSourceMetadata, resolveAgentDevtoolsMetadata, resolveAgentTriggerInvocation, resolveAgentTriggers, runAgentInline, streamAgent, streamAgentTrigger, withWorkspaceAgentDefaults } from "./index.ts"
import { streamAgentOutputToEvents } from "./agent-output.ts"
import { getAccessCapabilityOptions } from "./capabilities/access.ts"
import { CHAT_FINISH_EXTENSION_CONTEXT_KEY, getChatCapabilityOptions } from "./chat-trigger.ts"
import { uiMessagesToAgentMessages } from "./chat-message-input.ts"
import { createAgentInvocationContextStore } from "./invocation-context.ts"
import { resolveAgentInvoker, withResolvedAgentInvokerInput } from "./invoker.ts"
import { createAgentRuntimeContext } from "./runtime/context.ts"
import { toHttpErrorResponse } from "./http-error.ts"
import { createChatDevtoolsStreamResponse } from "./chat/devtools-stream.ts"

import type { AgentChatMessageTriggerInput } from "./chat-trigger.ts"
import type {
  AgentChatStateResolver,
  AgentCapabilityDefinition,
  AgentChannelDefinition,
  AgentChatErrorHookArgs,
  AgentChatFinishExtension,
  AgentChatMessage,
  AgentChatOptions,
  AgentDefinition,
  AgentInput,
  AgentInvoker,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeName,
  AgentWaitUntil,
  AgentWebhookRegistrationDefinition,
  MaybePromise,
  MaybeResolvable,
} from "./types.ts"
import type { AudioData, MessagePart } from "./messages.ts"
import { workspaceNameFromOptions } from "./workspace-agent.ts"
import type { WorkspaceAgentDefaults, WorkspaceAgentDefinition } from "./workspace-agent.ts"
import type {
  ChatDevtoolsConversation,
  ChatDevtoolsMetadata,
  ChatDevtoolsMetadataStatus,
  ChatDevtoolsStateResult,
} from "@vite-hub/devtools/chat-shared"
import type { WorkspaceName } from "@vite-hub/workspace"
import type { Adapter, Attachment, ChatConfig, Lock, Message as ChatSdkMessage, MessageContext, QueueEntry, StateAdapter, Thread, WebhookOptions } from "chat"
import type { UIMessage } from "ai"
import { registerWorkspace } from "@vite-hub/workspace/runtime"
import {
  chatDevtoolsClearRpc,
  chatDevtoolsGetStateRpc,
  chatDevtoolsMaterializeSourceRpc,
  chatDevtoolsSendRpc,
} from "@vite-hub/devtools/chat-shared"

interface ViteAgentRouteRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

interface ViteAgentRouteRuntimeContext extends AgentRuntimeContext<ViteAgentRouteRuntimeConfig> {
  request: Request
  runtime: AgentRuntimeName
  runtimeConfig: ViteAgentRouteRuntimeConfig
}

interface AgentRouteRuntimeOptions {
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"]
  waitUntil?: AgentWaitUntil
}

export interface AgentChatWebhookFetchOptions extends AgentRouteRuntimeOptions {
  agentName?: string
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
}

export interface AgentChatFetchOptions extends AgentRouteRuntimeOptions {
  agentName?: string
}

export interface AgentChatFetchMapInputContext {
  agentName: string
  body: AgentChatFetchBody
  input: AgentChatMessageTriggerInput
  request: Request
}

type AgentChatFetchInputPatch = Omit<Partial<AgentChatMessageTriggerInput>, "run"> & {
  run?: Partial<AgentRunMetadata>
}

export interface AgentChatFetchHandlerOptions {
  channelId?: string
  mapInput?: (context: AgentChatFetchMapInputContext) => MaybePromise<AgentChatFetchInputPatch | undefined | void>
  origin?: string
}

export interface RegisterWorkspaceAgentOptions<Name extends WorkspaceName = WorkspaceName> extends WorkspaceAgentDefaults<Name> {
  sourceRootDir?: string
}

export function registerWorkspaceAgent<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
  CALL_OPTIONS = unknown,
>(
  agent: WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS>,
  options: RegisterWorkspaceAgentOptions<Name> = {},
): WorkspaceAgentDefinition<TRuntimeConfig, Name, CALL_OPTIONS> {
  const preparedAgent = withWorkspaceAgentDefaults(agent, options)
  const workspaceOptions = preparedAgent.__vitehubWorkspaceAgentOptions
  if (typeof workspaceOptions.workspace === "string") return preparedAgent
  const sourceRootDir = preparedAgent.sourceRootDir ?? options.sourceRootDir
  if (sourceRootDir !== undefined) {
    const workspace = {
      ...workspaceOptions.workspace,
      sourceRootDir: workspaceOptions.workspace.sourceRootDir ?? sourceRootDir,
    }
    Object.assign(preparedAgent, workspace, {
      __vitehubWorkspaceAgentOptions: {
        ...workspaceOptions,
        workspace,
      },
    })
  }
  const workspaceName = workspaceNameFromOptions(preparedAgent.__vitehubWorkspaceAgentOptions as never, preparedAgent.__vitehubWorkspaceAgentDefaults)
  registerWorkspace(workspaceName, {
    ...preparedAgent,
    sourceRootDir,
  } as never)
  return preparedAgent
}

type AgentDefinitionWithCapabilities = {
  __vitehubWorkspaceAgentOptions?: {
    capabilities?: AgentCapabilityDefinition[]
  }
  capabilities?: AgentCapabilityDefinition[]
  chat?: AgentChatOptions
}

const defaultChatErrorFallbackText = "Sorry, I couldn't process that message."
const chatFinishMessagesKey = Symbol("vitehub.chat.finish.messages")
const chatNativeStreamUpdateIntervalMs = 1
const chatTypingRefreshIntervalMs = 4000
const chatTypingRefreshTimeoutMs = 2000

type AgentChatQueuedFinishExtension = AgentChatFinishExtension & {
  [chatFinishMessagesKey]: AgentChatMessage[]
}

interface ChatTypingRefresh {
  stop(): void
}

function createRouteBodyError(message: string): Error & { status?: number, statusCode?: number } {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 })
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function readableStreamFromResult(value: unknown): ReadableStream<unknown> {
  if (value instanceof ReadableStream) return value
  if (value instanceof Response && value.body) return value.body
  throw new Error("[vitehub] Agent chat trigger expected a UI message stream.")
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

function serializeErrorForLog(error: unknown, seen = new WeakSet<object>()): unknown {
  if (!(error instanceof Error)) {
    return error
  }
  if (seen.has(error)) {
    return { message: "[Circular Error]", name: error.name }
  }
  seen.add(error)

  const output: Record<string, unknown> = {
    message: error.message,
    name: error.name,
  }
  if (error.stack) output.stack = error.stack
  for (const key of Object.keys(error)) {
    output[key] = serializeErrorForLog((error as unknown as Record<string, unknown>)[key], seen)
  }
  if ("cause" in error && typeof error.cause !== "undefined") {
    output.cause = serializeErrorForLog(error.cause, seen)
  }
  return output
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

async function runWithRuntimeCloudflareEnv<T>(
  context: ViteAgentRouteRuntimeContext,
  callback: () => Promise<T>,
): Promise<T> {
  if (!context.cloudflare?.env) {
    return callback()
  }
  return await runWithActiveCloudflareEnv(context.cloudflare.env, callback)
}

async function resolveRuntimeWaitUntil(waitUntil: AgentWaitUntil | undefined): Promise<AgentWaitUntil | undefined> {
  if (detectRuntime() !== "vercel") return waitUntil
  const vercel = await import("@vercel/functions").catch(() => undefined) as { waitUntil?: AgentWaitUntil } | undefined
  return vercel?.waitUntil || waitUntil
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
  return registrations.find(registration => registration.id === webhook || registration.provider === webhook || (registration.channelId === webhook && registration.id === registration.channelId))
}

async function resolveChatAdapters(
  options: AgentChatOptions | undefined,
  context: ViteAgentRouteRuntimeContext,
): Promise<Record<string, Adapter>> {
  const adapters = await resolveMaybe(
    options?.platforms as MaybeResolvable<Record<string, MaybeResolvable<Adapter, ViteAgentRouteRuntimeContext>>, ViteAgentRouteRuntimeContext> | undefined,
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
  if (registration.adapter && adapters[registration.adapter]) return registration.adapter
  if (registration.channelId && adapters[registration.channelId]) return registration.channelId
  if (adapters[registration.provider]) return registration.provider
  if (registration.id && adapters[registration.id]) return registration.id
  return undefined
}

function chatRegistrationOrigin(registration: AgentWebhookRegistrationDefinition): string {
  return registration.channelId || registration.provider
}

function objectWithoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function fallbackWebhookFromRequest(request: Request): string | undefined {
  return new URL(request.url).pathname.split("/").filter(Boolean).at(-1) || undefined
}

async function collectAgentOutput(result: unknown): Promise<string> {
  if (result instanceof Response) {
    if (result.headers.get("content-type")?.includes("application/json")) {
      const body = await result.clone().json().catch(() => undefined)
      if (isRecord(body) && typeof body.text === "string") {
        return body.text
      }
    }
    return await result.text()
  }

  let text = ""
  for await (const event of streamAgentOutputToEvents(result)) {
    if (event.type === "text-delta") {
      text += event.text
    }
    if (event.type === "error") {
      throw new Error(event.error)
    }
  }
  return text.trim()
}

type ChatTextStream = AsyncIterable<string> & {
  getText: () => string
}

function startChatTypingRefresh(thread: Thread, context: ViteAgentRouteRuntimeContext): ChatTypingRefresh {
  let stopped = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  let wake: (() => void) | undefined

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    wake = resolve
    timeout = setTimeout(() => {
      timeout = undefined
      wake = undefined
      resolve()
    }, ms)
  })

  const boundedStartTyping = async () => {
    let limit: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        thread.startTyping().catch(() => undefined),
        new Promise(resolve => {
          limit = setTimeout(resolve, chatTypingRefreshTimeoutMs)
        }),
      ])
    }
    finally {
      if (limit) {
        clearTimeout(limit)
      }
    }
  }

  const task = (async () => {
    while (!stopped) {
      await boundedStartTyping()
      if (!stopped) {
        await sleep(chatTypingRefreshIntervalMs)
      }
    }
  })()

  context.waitUntil(task)

  return {
    stop() {
      if (stopped) return
      stopped = true
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
      wake?.()
      wake = undefined
    },
  }
}

function streamAgentOutputToChatText(
  result: Promise<unknown>,
): ChatTextStream {
  let collected = ""
  return {
    async *[Symbol.asyncIterator]() {
      const output = await result
      if (output instanceof Response) {
        if (output.headers.get("content-type")?.includes("application/json")) {
          const body = await output.clone().json().catch(() => undefined)
          if (isRecord(body)) {
            if (typeof body.text === "string") {
              collected += body.text
              yield body.text
            }
            return
          }
        }
        const bodyText = await output.text()
        collected += bodyText
        yield bodyText
        return
      }

      for await (const event of streamAgentOutputToEvents(output)) {
        if (event.type === "text-delta") {
          collected += event.text
          yield event.text
        }
        if (event.type === "error") {
          throw new Error(event.error)
        }
      }
    },
    getText: () => collected,
  }
}

function chatStreamPostable(thread: Thread, response: ChatTextStream): ChatTextStream | StreamingPlan {
  return thread.adapter.stream
    ? new StreamingPlan(response, { updateIntervalMs: chatNativeStreamUpdateIntervalMs })
    : response
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
  const origin = chatRegistrationOrigin(registration)
  const state = await resolveMaybe(
    (options?.state ?? handlerOptions.state) as AgentChatStateResolver<ViteAgentRouteRuntimeConfig> | undefined,
    {
      ...context,
      chat: {
        agentName,
        stateKeyPrefix: `chat:${agentName}:${origin}:`,
      },
    } as never,
  )
  return state || getInMemoryChatState(`${agentName}:${origin}`)
}

function chatSdkOption<T>(options: AgentChatOptions | undefined, key: string): T | undefined {
  return isRecord(options) ? options[key] as T | undefined : undefined
}

function createChatSdkConfig(
  adapters: Record<string, Adapter>,
  state: StateAdapter,
  options: AgentChatOptions | undefined,
): ChatConfig {
  const fallbackStreamingPlaceholderText = typeof options?.fallbackStreamingPlaceholderText === "string"
    ? options.fallbackStreamingPlaceholderText
    : null
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

function chatMessageAuthorEmail(message: ChatSdkMessage): string | undefined {
  return firstString(
    (message.author as { email?: unknown }).email,
    (message.author as { mail?: unknown }).mail,
    (message.author as { userPrincipalName?: unknown }).userPrincipalName,
  )
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
  channelId?: string,
): AgentChatMessageTriggerInput {
  const platformChannelId = thread.adapter.channelIdFromThreadId(message.threadId)
  const metadata = objectWithoutUndefined({
    chat: objectWithoutUndefined({
      edited: message.metadata.edited,
      editedAt: isoDate(message.metadata.editedAt),
      isMention: message.isMention,
      messageId: message.id,
      platform: objectWithoutUndefined({
        channelId: platformChannelId,
        threadId: message.threadId,
      }),
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
  const email = chatMessageAuthorEmail(message)
  return {
    ...(email ? { meta: { email } } : {}),
    messages: [{
      createdAt: isoDate(message.metadata.dateSent),
      id: message.id,
      metadata,
      parts: chatMessageParts(message),
      role: "user",
    }],
    run: {
      channelId: channelId || platformChannelId,
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

function chatErrorHookArgs(
  thread: Thread,
  message: ChatSdkMessage,
  input: AgentChatMessageTriggerInput | undefined,
  run: AgentRunMetadata | undefined,
  error: unknown,
): AgentChatErrorHookArgs<ViteAgentRouteRuntimeConfig> {
  const inputMessage = input?.messages.at(-1)
  const metadata = inputMessage?.metadata && typeof inputMessage.metadata === "object"
    ? inputMessage.metadata as Record<string, unknown>
    : undefined
  return {
    error,
    history: input ? uiMessagesToAgentMessages(input.messages) : [],
    message: {
      id: inputMessage?.id || message.id,
      ...(metadata ? { metadata } : {}),
      text: message.text,
    },
    run,
    thread: {
      post: async postedMessage => postChatMessage(thread, postedMessage as AgentChatMessage),
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

async function resolveChatErrorFallbackText(
  options: AgentChatOptions | undefined,
  args: AgentChatErrorHookArgs<ViteAgentRouteRuntimeConfig>,
): Promise<string | undefined> {
  const fallback = options?.errorFallbackText
  if (fallback === null) return undefined
  if (typeof fallback === "function") {
    const resolved = await fallback(args)
    return resolved || undefined
  }
  if (typeof fallback === "string") return fallback
  return defaultChatErrorFallbackText
}

async function postChatErrorFallback(
  error: unknown,
  thread: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
  input: AgentChatMessageTriggerInput | undefined,
  run: AgentRunMetadata | undefined,
): Promise<void> {
  console.error({
    component: "@vite-hub/agent",
    error: serializeErrorForLog(error),
    event: "chat.message.error",
    message_id: message.id,
    thread_id: message.threadId,
  })
  const fallback = await resolveChatErrorFallbackText(options, chatErrorHookArgs(thread, message, input, run, error))
  if (fallback) {
    await thread.post(fallback).catch(() => undefined)
  }
}

function createChatFinishExtension(
  input: AgentChatMessageTriggerInput,
  registration: AgentWebhookRegistrationDefinition,
): AgentChatQueuedFinishExtension {
  const messages: AgentChatMessage[] = []
  return {
    [chatFinishMessagesKey]: messages,
    provider: chatRegistrationOrigin(registration),
    ...(input.run ? { run: input.run } : {}),
    sendMessage: async (message) => {
      messages.push(message)
    },
  }
}

async function flushChatFinishExtensionMessages(
  thread: Thread,
  chat: AgentChatQueuedFinishExtension,
): Promise<void> {
  const messages = chat[chatFinishMessagesKey].splice(0)
  for (const message of messages) {
    await postChatMessage(thread, message)
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
  input: AgentRunInput,
  run: AgentRunMetadata | undefined,
  messageContext?: MessageContext,
): Promise<AgentInvoker | undefined> {
  const invocationContext = createAgentInvocationContextStore(input.context)
  const invoker = await resolveAgentInvoker(
    (agent as AgentDefinition<ViteAgentRouteRuntimeConfig> | undefined)?.invoker,
    context,
    invocationContext,
    input,
    run,
  )
  for (const accessOptions of getAccessCapabilityOptions(getAgentCapabilities(agent))) {
    if (!accessOptions.chat) continue
    const result = await accessOptions.chat.resolve({
      ...context,
      invoker,
      input: accessChatInput(thread, message, messageContext),
      provider: chatRegistrationOrigin(registration),
      request: context.request,
      webhook: registration,
    })
    if (result === false) return
  }
  return invoker
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
  let input: AgentChatMessageTriggerInput | undefined
  let run: AgentRunMetadata | undefined
  let typing: ChatTypingRefresh | undefined
  try {
    input = createChatTriggerInput(chatRegistrationOrigin(registration), thread, message, messageContext, registration.channelId)
    const firstMessage = input.messages[0]
    if (!firstMessage || !Array.isArray(firstMessage.parts) || firstMessage.parts.length === 0) return
    const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, "chat.message", input)
    const invoker = await isChatMessageAuthorized(agent, context, registration, thread, message, invocation.input as AgentRunInput, invocation.run, messageContext)
    if (!invoker) return

    typing = options?.stream !== false ? startChatTypingRefresh(thread, context) : undefined
    run = invocation.run
    const runContext = {
      ...context,
      ...(invocation.run ? { run: invocation.run } : {}),
    }
    const chatFinish = createChatFinishExtension(input, registration)
    const invocationInput = withChatFinishExtension(withResolvedAgentInvokerInput(invocation.input as AgentRunInput, invoker), chatFinish)
    if (options?.stream === false) {
      const result = await runAgentInline(agent as never, runContext as never, invocationInput as never)
      const text = await collectAgentOutput(result)
      if (text) {
        await thread.post({ markdown: text })
      }
      await flushChatFinishExtensionMessages(thread, chatFinish)
    }
    else {
      const result = streamAgent(agent as never, runContext as never, invocationInput as never, {
        output: "events",
      })
      const response = streamAgentOutputToChatText(result)
      try {
        await thread.post(chatStreamPostable(thread, response) as never)
      }
      finally {
        typing?.stop()
      }
      await flushChatFinishExtensionMessages(thread, chatFinish)
    }
  }
  catch (error) {
    typing?.stop()
    await postChatErrorFallback(error, thread, message, options, input, run)
    throw error
  }
  finally {
    typing?.stop()
  }
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

type AgentChatDevtoolsAction = "clear" | "get-state" | "materialize-source" | "send"
type CreateUIMessageStreamResponse = typeof import("ai").createUIMessageStreamResponse
type ReadUIMessageStream = typeof import("ai").readUIMessageStream

export type AgentChatFetchBody = {
  history?: AgentChatMessageTriggerInput["history"]
  id?: string
  invoker?: unknown
  invokerProfileId?: unknown
  messageId?: string
  meta?: unknown
  messages?: unknown
  run?: unknown
  session?: unknown
  trigger?: string
  user?: unknown
}

type AgentChatDevtoolsBridgeBody = {
  action?: string
  chat?: string
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: unknown
  path?: string
  source?: string
  stream?: boolean
  text?: string
}

interface AgentChatDevtoolsInvokerSelection {
  invokerFallback?: boolean
  invokerProfileId?: string
  meta?: Record<string, unknown>
}

interface AgentChatDevtoolsSession {
  invokerFallback?: boolean
  invokerProfileId?: string
  thinkingFallback?: string | null
  title?: string
  uiMessages: UIMessage[]
}

interface AgentChatDevtoolsFetchState {
  metadata: ChatDevtoolsMetadata
  metadataError?: string
  metadataSelectionKey?: string
  metadataStatus: ChatDevtoolsMetadataStatus
  metadataTask?: Promise<void>
  session: AgentChatDevtoolsSession
}

export interface AgentChatDevtoolsFetchHandlerOptions extends AgentRouteRuntimeOptions {
  defaults?: WorkspaceAgentDefaults
  emptyAssistantText?: string
  meta?: Record<string, unknown>
  name?: string
}

export type AgentChatDevtoolsFetchRequestOptions = AgentRouteRuntimeOptions

function normalizeChatDevtoolsAction(action: string): AgentChatDevtoolsAction | undefined {
  if (action === "get-state" || action === chatDevtoolsGetStateRpc) return "get-state"
  if (action === "send" || action === chatDevtoolsSendRpc) return "send"
  if (action === "clear" || action === chatDevtoolsClearRpc) return "clear"
  if (action === "materialize-source" || action === chatDevtoolsMaterializeSourceRpc) return "materialize-source"
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) && !Array.isArray(value) ? { ...value } : undefined
}

function agentChatDevtoolsName(agent: AgentInput<ViteAgentRouteRuntimeContext>, options: AgentChatDevtoolsFetchHandlerOptions): string {
  const candidate = options.name || (isRecord(agent) && typeof agent.name === "string" ? agent.name : undefined)
  return candidate?.trim() || "agent"
}

function canResolveAgentDevtoolsMetadata(agent: AgentInput<ViteAgentRouteRuntimeContext>): boolean {
  return Boolean((agent as { __vitehubWorkspaceAgent?: unknown }).__vitehubWorkspaceAgent)
}

function createStaticAgentDevtoolsMetadata(agent: AgentInput<ViteAgentRouteRuntimeContext>): ChatDevtoolsMetadata {
  return createAgentDevtoolsMetadata(agent as never)
}

function chatDevtoolsMetadataStatus(agent: AgentInput<ViteAgentRouteRuntimeContext>): ChatDevtoolsMetadataStatus {
  return canResolveAgentDevtoolsMetadata(agent) ? "loading" : "ready"
}

function chatDevtoolsUser(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const email = typeof meta?.email === "string" && meta.email.trim() ? meta.email.trim() : undefined
  return {
    id: email ? `devtools:${email}` : "devtools",
    ...(email ? { email } : {}),
    name: "DevTools User",
  }
}

function createDevtoolsMetadataInput(selection: AgentChatDevtoolsInvokerSelection = {}): AgentRunInput {
  const meta = optionalRecord(selection.meta)
  return {
    context: {
      invoker: {
        id: "devtools",
        kind: "devtools",
        label: "DevTools User",
        ...(meta ? { meta } : {}),
      },
      ...(!selection.invokerFallback && selection.invokerProfileId ? { invokerProfileId: selection.invokerProfileId } : {}),
      chat: {
        message: { metadata: {} },
        ...(meta ? { meta } : {}),
        run: { origin: "devtools" },
        user: chatDevtoolsUser(meta),
      },
    },
    messages: [],
  }
}

function validMetadataInvokerProfileId(metadata: ChatDevtoolsMetadata | undefined, value: string | undefined): string | undefined {
  return value && metadata?.invokerProfiles?.some(profile => profile.id === value)
    ? value
    : undefined
}

function assertKnownInvokerProfile(metadata: ChatDevtoolsMetadata | undefined, invokerProfileId: string | undefined): Response | undefined {
  if (invokerProfileId && !validMetadataInvokerProfileId(metadata, invokerProfileId)) {
    return createJsonErrorResponse(400, `Unknown invoker profile: ${invokerProfileId}`)
  }
}

function normalizeInvokerSelection(input: { invokerFallback?: boolean, invokerProfileId?: string, meta?: unknown } | undefined, defaultMeta?: Record<string, unknown>): AgentChatDevtoolsInvokerSelection {
  const meta = optionalRecord(input?.meta) ?? optionalRecord(defaultMeta)
  if (input?.invokerFallback === true) {
    return {
      invokerFallback: true,
      ...(meta ? { meta } : {}),
    }
  }
  const invokerProfileId = input?.invokerProfileId?.trim()
  return {
    ...(invokerProfileId ? { invokerProfileId } : {}),
    ...(meta ? { meta } : {}),
  }
}

function metadataSelectionForAgent(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  selection: AgentChatDevtoolsInvokerSelection = {},
): AgentChatDevtoolsInvokerSelection {
  const meta = optionalRecord(selection.meta)
  if (selection.invokerFallback) {
    return {
      invokerFallback: true,
      ...(meta ? { meta } : {}),
    }
  }
  const invokerProfileId = validMetadataInvokerProfileId(createStaticAgentDevtoolsMetadata(agent), selection.invokerProfileId)
  return {
    ...(invokerProfileId ? { invokerProfileId } : {}),
    ...(meta ? { meta } : {}),
  }
}

function metadataSelectionKey(selection: AgentChatDevtoolsInvokerSelection = {}): string {
  const invoker = selection.invokerFallback ? "fallback" : selection.invokerProfileId ? `profile:${selection.invokerProfileId}` : "default"
  return `${invoker}:${JSON.stringify(selection.meta || {})}`
}

function metadataErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Chat DevTools metadata inspection failed."
}

async function startAgentDevtoolsMetadataResolution(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  state: AgentChatDevtoolsFetchState,
  options: AgentChatDevtoolsFetchHandlerOptions,
  runtime: ViteAgentRouteRuntimeContext,
  selection: AgentChatDevtoolsInvokerSelection = {},
  resolution: { force?: boolean } = {},
): Promise<void> {
  if (!canResolveAgentDevtoolsMetadata(agent)) {
    state.metadataError = undefined
    state.metadataSelectionKey = "static"
    state.metadataStatus = "ready"
    state.metadataTask = undefined
    return
  }

  const metadataSelection = metadataSelectionForAgent(agent, selection)
  const selectionKey = metadataSelectionKey(metadataSelection)
  if (!resolution.force && state.metadataSelectionKey === selectionKey) return

  state.metadata = createStaticAgentDevtoolsMetadata(agent)
  state.metadataError = undefined
  state.metadataSelectionKey = selectionKey
  state.metadataStatus = "loading"

  const task = resolveAgentDevtoolsMetadata(agent as never, {
    ...options.defaults,
    input: createDevtoolsMetadataInput(metadataSelection),
    runtime,
  } as never)
    .then((metadata) => {
      if (state.metadataTask !== task || state.metadataSelectionKey !== selectionKey) return
      state.metadata = metadata
      state.metadataError = undefined
      state.metadataStatus = "ready"
      state.metadataTask = undefined
    })
    .catch((cause) => {
      if (state.metadataTask !== task || state.metadataSelectionKey !== selectionKey) return
      state.metadataError = metadataErrorMessage(cause)
      state.metadataStatus = "error"
      state.metadataTask = undefined
    })
  state.metadataTask = task
  if (resolution.force) await task
}

function titleFromUIMessage(message: UIMessage): string | undefined {
  for (const part of message.parts || []) {
    const data = (part as { data?: unknown }).data
    if (
      (part as { type?: unknown }).type === "data-chat-title"
      && data
      && typeof data === "object"
      && (data as { type?: unknown }).type === "chat-title"
      && typeof (data as { title?: unknown }).title === "string"
    ) {
      const title = (data as { title: string }).title.trim()
      if (title) return title
    }
  }
}

function titleFromUIMessages(messages: UIMessage[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const title = titleFromUIMessage(message)
    if (title) return title
  }
}

function sessionTitle(session: AgentChatDevtoolsSession): string | undefined {
  const title = session.title || titleFromUIMessages(session.uiMessages)
  if (title) session.title = title
  return title
}

function serializeAgentChatDevtoolsState(
  name: string,
  state: AgentChatDevtoolsFetchState,
  requestedSelection: AgentChatDevtoolsInvokerSelection = {},
): ChatDevtoolsStateResult {
  const title = sessionTitle(state.session) || state.metadata.title
  const invokerProfileId = state.session.invokerProfileId || (!requestedSelection.invokerFallback ? validMetadataInvokerProfileId(state.metadata, requestedSelection.invokerProfileId) : undefined)
  const invokerFallback = state.session.invokerFallback || (!invokerProfileId && requestedSelection.invokerFallback === true)
  const chats: ChatDevtoolsConversation[] = [{
    messages: [],
    ...(invokerFallback ? { invokerFallback: true } : {}),
    ...(invokerProfileId ? { invokerProfileId } : {}),
    name,
    ...(title ? { title } : {}),
    uiMessages: [...state.session.uiMessages],
  }]

  return {
    chats,
    files: state.metadata.files || [],
    instructions: state.metadata.instructions || [],
    ...(invokerFallback ? { invokerFallback: true } : {}),
    ...(invokerProfileId ? { invokerProfileId } : {}),
    invokerProfiles: state.metadata.invokerProfiles || [],
    ...(requestedSelection.meta ? { meta: requestedSelection.meta } : {}),
    ...(state.metadataError ? { metadataError: state.metadataError } : {}),
    metadataStatus: state.metadataStatus,
    selected: name,
    thinkingFallback: state.session.thinkingFallback ?? null,
    ...(title ? { title } : {}),
    tools: state.metadata.tools || [],
    uiMessages: [...state.session.uiMessages],
    ...(state.metadata.version ? { version: state.metadata.version } : {}),
  }
}

function createDevtoolsRunMetadata(name: string, userMessageId: string): AgentRunMetadata {
  return {
    channelId: `devtools:${name}`,
    messageId: userMessageId,
    origin: "devtools",
    runId: globalThis.crypto?.randomUUID?.() || `devtools-run-${randomToken()}`,
    threadId: `devtools:${name}:thread`,
  }
}

function createUserUIMessage(text: string): UIMessage {
  return {
    id: `devtools-user-${randomToken()}`,
    metadata: {},
    parts: [{ text, type: "text" }],
    role: "user",
  }
}

function createHttpChatRunMetadata(
  agentName: string,
  body: AgentChatFetchBody,
  messages: UIMessage[],
  options: Pick<AgentChatFetchHandlerOptions, "channelId" | "origin"> = {},
): AgentRunMetadata {
  const chatId = optionalBodyString(body.id, "id") || "default"
  const messageId = optionalBodyString(body.messageId, "messageId") || messages.at(-1)?.id || randomToken()
  const channelId = options.channelId || `http:${agentName}`
  const origin = options.origin || "http"
  return {
    channelId,
    messageId,
    origin,
    runId: globalThis.crypto?.randomUUID?.() || `${origin}-run-${randomToken()}`,
    threadId: `${channelId}:${chatId}`,
  }
}

async function parseAgentChatFetchBody(request: Request): Promise<AgentChatFetchBody> {
  const raw = await request.text()
  if (!raw.trim()) throw createRouteBodyError("Missing agent chat payload.")
  try {
    const body = JSON.parse(raw) as AgentChatFetchBody
    if (!isRecord(body)) throw createRouteBodyError("Agent chat payload must be a JSON object.")
    return body
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error
    throw createRouteBodyError("Malformed agent chat payload.")
  }
}

function optionalBodyRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw createRouteBodyError(`${label} must be an object when provided.`)
  return { ...value }
}

function optionalBodyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw createRouteBodyError(`${label} must be a string when provided.`)
  const trimmed = value.trim()
  return trimmed || undefined
}

function agentChatFetchInput(
  body: AgentChatFetchBody,
  agentName: string,
  allowTrustedInput = false,
  options: Pick<AgentChatFetchHandlerOptions, "channelId" | "origin"> = {},
): AgentChatMessageTriggerInput {
  if (!Array.isArray(body.messages)) {
    throw createRouteBodyError("Agent chat payload requires a messages array.")
  }
  if (!allowTrustedInput && ("invoker" in body || "invokerProfileId" in body || "meta" in body || "run" in body || "user" in body)) {
    throw createRouteBodyError("Agent chat route identity must be derived server-side with defineAgent({ invoker }).")
  }
  const messages = body.messages as UIMessage[]
  const session = optionalBodyRecord(body.session, "session") as AgentChatMessageTriggerInput["session"] | undefined
  return {
    ...(body.history !== undefined ? { history: body.history } : {}),
    messages,
    run: createHttpChatRunMetadata(agentName, body, messages, options),
    ...(session ? { session } : {}),
  }
}

function agentChannelRouteOptions(channelId: string, channel: AgentChannelDefinition): AgentChatFetchHandlerOptions | undefined {
  if (channel.route === undefined || channel.route === false) return undefined
  if (channel.route === true) {
    return {
      channelId,
      origin: channel.kind,
    }
  }
  if (isRecord(channel.route) && !Array.isArray(channel.route)) {
    return {
      channelId,
      origin: channel.kind,
      ...channel.route,
    } as AgentChatFetchHandlerOptions
  }
  throw new TypeError(`[vitehub] Channel "${channelId}" route must be true or an agent chat route options object.`)
}

function resolveAgentChatFetchHandlerOptions(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChatFetchHandlerOptions = {},
): AgentChatFetchHandlerOptions {
  const channels = isRecord(agent) && isRecord(agent.channels) && !Array.isArray(agent.channels)
    ? agent.channels as Record<string, AgentChannelDefinition>
    : {}
  const routeEntries = Object.entries(channels)
    .map(([channelId, channel]) => [channelId, agentChannelRouteOptions(channelId, channel)] as const)
    .filter((entry): entry is readonly [string, AgentChatFetchHandlerOptions] => entry[1] !== undefined)

  if (routeEntries.length > 1) {
    throw new TypeError("[vitehub] defineAgentChatFetchHandler() found multiple route-enabled Channels. Keep one route-enabled Channel per generated chat route.")
  }

  const channelOptions = routeEntries[0]?.[1]
  return {
    ...channelOptions,
    ...options,
    mapInput: options.mapInput ?? channelOptions?.mapInput,
  }
}

function mergeAgentChatFetchInput(
  input: AgentChatMessageTriggerInput,
  patch: AgentChatFetchInputPatch | undefined | void,
): AgentChatMessageTriggerInput {
  if (patch === undefined) return input
  if (!isRecord(patch)) throw createRouteBodyError("Agent chat route input mapper must return an object.")
  const { run, session, ...rest } = patch
  return {
    ...input,
    ...rest,
    ...(run ? { run: { ...input.run, ...run } as AgentRunMetadata } : {}),
    ...(session ? { session: { ...input.session, ...session } } : {}),
  }
}

function uiMessageMetadata(message: UIMessage): Record<string, unknown> | undefined {
  return optionalRecord(message.metadata)
}

function hasCompletedMetadata(message: UIMessage): boolean {
  const completedAt = uiMessageMetadata(message)?.completedAt
  return typeof completedAt === "string" && completedAt.trim().length > 0
}

function isToolUIMessagePart(part: unknown): part is Record<string, unknown> {
  const record = optionalRecord(part)
  if (!record) return false
  return record.type === "dynamic-tool"
    || (typeof record.type === "string" && record.type.startsWith("tool-"))
}

function uiToolPartName(part: Record<string, unknown>): string | undefined {
  if (part.type === "dynamic-tool") {
    return typeof part.toolName === "string" && part.toolName ? part.toolName : undefined
  }
  if (typeof part.type === "string" && part.type.startsWith("tool-")) {
    const name = part.type.slice("tool-".length)
    return name || undefined
  }
}

function uiToolPartId(part: Record<string, unknown>, name: string, index: number): string {
  if (typeof part.toolCallId === "string" && part.toolCallId) return part.toolCallId
  if (typeof part.id === "string" && part.id) return part.id
  return `${name}-${index}`
}

function toolPartHasOutput(part: Record<string, unknown>): boolean {
  return part.state === "output-available"
    || part.state === "output-denied"
    || Object.prototype.hasOwnProperty.call(part, "output")
    || typeof part.errorText === "string"
}

function completedMaterializeSourceToolIds(message: UIMessage): string[] {
  return (message.parts || []).flatMap((part, index) => {
    if (!isToolUIMessagePart(part) || !toolPartHasOutput(part)) return []
    const name = uiToolPartName(part)
    return name === "materialize_sources" ? [uiToolPartId(part, name, index)] : []
  })
}

function hasIncompleteToolParts(message: UIMessage): boolean {
  return (message.parts || []).some(part => isToolUIMessagePart(part) && !toolPartHasOutput(part))
}

function isIncompleteAssistantHistoryMessage(message: UIMessage): boolean {
  return message.role === "assistant" && !hasCompletedMetadata(message) && hasIncompleteToolParts(message)
}

function createChatDevtoolsPromptHistory(messages: UIMessage[]): UIMessage[] {
  return messages.filter(message => !isIncompleteAssistantHistoryMessage(message))
}

function textFromUIMessage(message: UIMessage): string {
  return (message.parts || [])
    .filter((part): part is { text: string, type: "text" } => (
      (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string"
    ))
    .map(part => part.text)
    .join("")
}

function ensureVisibleAssistantMessage(message: UIMessage, text: string | undefined): UIMessage {
  if (textFromUIMessage(message).trim() || !text) return message

  return {
    ...message,
    parts: [
      ...(message.parts || []),
      { text, type: "text" },
    ],
  }
}

function materializedSourceKeys(metadata: ChatDevtoolsMetadata | undefined): string[] {
  const sources = new Set<string>()
  const pending = [...(metadata?.files || [])]
  while (pending.length) {
    const file = pending.shift()!
    if (file.source && (file.status === "ready" || file.materialized || file.materializedAt)) {
      sources.add(file.source)
    }
    pending.push(...(file.children || []))
  }
  return [...sources]
}

function parseChatDevtoolsBridgeBody(rawBody: string): AgentChatDevtoolsBridgeBody | undefined {
  if (!rawBody.trim()) return undefined
  try {
    return JSON.parse(rawBody) as AgentChatDevtoolsBridgeBody
  }
  catch {
    throw createRouteBodyError("Malformed chat devtools payload.")
  }
}

function chatDevtoolsErrorResponse(error: unknown): Response {
  if (error instanceof Response) return error
  const response = toHttpErrorResponse(error)
  if (response) return response
  return createJsonErrorResponse(500, error instanceof Error ? error.message : "Chat DevTools bridge failed.")
}

function withChatDevtoolsCors(response: Response): Response {
  response.headers.set("access-control-allow-origin", "*")
  response.headers.set("access-control-allow-methods", "POST, OPTIONS")
  response.headers.set("access-control-allow-headers", "content-type")
  return response
}

async function materializeDevtoolsSource(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  state: AgentChatDevtoolsFetchState,
  options: AgentChatDevtoolsFetchHandlerOptions,
  runtime: ViteAgentRouteRuntimeContext,
  input: AgentChatDevtoolsBridgeBody,
): Promise<Response | ChatDevtoolsStateResult> {
  if (!input.source && !input.path) {
    return createBadRequest("Missing workspace source or path.")
  }

  const requestedSelection = normalizeInvokerSelection(input, options.meta)
  const invalidProfile = assertKnownInvokerProfile(state.metadata, requestedSelection.invokerProfileId)
  if (invalidProfile) return invalidProfile

  const metadataSelection = metadataSelectionForAgent(agent, requestedSelection)
  state.metadataStatus = "loading"
  state.metadataError = undefined

  try {
    state.metadata = await materializeAgentDevtoolsSourceMetadata(agent as never, {
      ...options.defaults,
      input: createDevtoolsMetadataInput(metadataSelection),
      ...(input.path ? { path: input.path } : {}),
      ...(input.source ? { source: input.source } : {}),
      runtime,
      sources: materializedSourceKeys(state.metadata),
    } as never)
    state.metadataSelectionKey = metadataSelectionKey(metadataSelection)
    state.metadataStatus = "ready"
    state.metadataTask = undefined
  }
  catch (cause) {
    state.metadataError = metadataErrorMessage(cause)
    state.metadataStatus = "error"
  }

  return serializeAgentChatDevtoolsState(agentChatDevtoolsName(agent, options), state, requestedSelection)
}

async function sendDevtoolsUIMessage(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  request: Request,
  state: AgentChatDevtoolsFetchState,
  options: AgentChatDevtoolsFetchHandlerOptions,
  requestOptions: AgentChatDevtoolsFetchRequestOptions,
  input: AgentChatDevtoolsBridgeBody,
  onChange?: (next: ChatDevtoolsStateResult) => void | Promise<void>,
): Promise<Response | ChatDevtoolsStateResult> {
  if (!input.stream) {
    return createBadRequest("Chat DevTools sends require stream: true.")
  }

  const text = input.text?.trim()
  if (!text) {
    return createBadRequest("Missing chat message text.")
  }

  const requestedSelection = normalizeInvokerSelection(input, options.meta)
  const requestedProfileId = requestedSelection.invokerProfileId
  const invalidProfile = assertKnownInvokerProfile(state.metadata, requestedProfileId)
  if (invalidProfile) return invalidProfile
  if (
    state.session.uiMessages.length > 0
    && ((requestedSelection.invokerFallback && !state.session.invokerFallback)
      || (requestedProfileId && (state.session.invokerFallback || (state.session.invokerProfileId && requestedProfileId !== state.session.invokerProfileId))))
  ) {
    return createJsonErrorResponse(409, "Clear the conversation to change invoker.")
  }
  if (!state.session.uiMessages.length) {
    state.session.invokerFallback = requestedSelection.invokerFallback === true
    state.session.invokerProfileId = state.session.invokerFallback
      ? undefined
      : requestedProfileId || state.metadata.invokerProfiles?.[0]?.id
  }

  const name = agentChatDevtoolsName(agent, options)
  const userMessage = createUserUIMessage(text)
  const baseMessages = [...createChatDevtoolsPromptHistory(state.session.uiMessages), userMessage]
  const run = createDevtoolsRunMetadata(name, userMessage.id)
  const startedAt = new Date().toISOString()
  state.session.uiMessages = baseMessages
  state.session.thinkingFallback = null
  await onChange?.(serializeAgentChatDevtoolsState(name, state, requestedSelection))

  const runtimeContext = createRuntimeContext(
    request,
    run,
    await resolveRuntimeWaitUntil(requestOptions.waitUntil ?? options.waitUntil),
    requestOptions.cloudflare ?? options.cloudflare,
  )
  const triggerInput: AgentChatMessageTriggerInput = {
    ...(state.session.invokerProfileId ? { invokerProfileId: state.session.invokerProfileId } : {}),
    ...(requestedSelection.meta ? { meta: requestedSelection.meta } : {}),
    messages: baseMessages,
    run,
    timeout: 90_000,
    user: chatDevtoolsUser(requestedSelection.meta),
  }
  const stream = readableStreamFromResult(await runWithRuntimeCloudflareEnv(runtimeContext, async () => await streamAgentTrigger(agent as never, runtimeContext as never, "chat.message", triggerInput, {
    output: "ui-message-stream",
    async onInvocation(invocation) {
      state.session.thinkingFallback = typeof invocation.metadata?.thinkingFallback === "string"
        ? invocation.metadata.thinkingFallback
        : null
      await onChange?.(serializeAgentChatDevtoolsState(name, state, requestedSelection))
    },
  })))
  const { readUIMessageStream } = await import("ai") as { readUIMessageStream: ReadUIMessageStream }
  let latestAssistant: UIMessage | undefined
  const refreshedMaterializationToolIds = new Set<string>()
  async function refreshCompletedMaterializations(message: UIMessage): Promise<void> {
    const completedIds = completedMaterializeSourceToolIds(message)
      .filter(id => !refreshedMaterializationToolIds.has(id))
    if (!completedIds.length) return

    for (const id of completedIds) refreshedMaterializationToolIds.add(id)
    await startAgentDevtoolsMetadataResolution(agent, state, options, runtimeContext, requestedSelection, { force: true })
  }

  for await (const assistantMessage of readUIMessageStream({ stream: stream as never })) {
    const now = new Date().toISOString()
    latestAssistant = {
      ...assistantMessage as UIMessage,
      metadata: {
        ...((assistantMessage as UIMessage).metadata as Record<string, unknown> | undefined),
        createdAt: startedAt,
        updatedAt: now,
      },
    }
    state.session.title = titleFromUIMessage(latestAssistant) || state.session.title
    state.session.uiMessages = [...baseMessages, latestAssistant]
    await refreshCompletedMaterializations(latestAssistant)
    await onChange?.(serializeAgentChatDevtoolsState(name, state, requestedSelection))
  }
  if (latestAssistant) {
    latestAssistant = {
      ...latestAssistant,
      metadata: {
        ...(latestAssistant.metadata as Record<string, unknown> | undefined),
        completedAt: new Date().toISOString(),
      },
    }
    latestAssistant = ensureVisibleAssistantMessage(latestAssistant, options.emptyAssistantText)
    state.session.title = titleFromUIMessage(latestAssistant) || state.session.title
    state.session.uiMessages = [...baseMessages, latestAssistant]
    await onChange?.(serializeAgentChatDevtoolsState(name, state, requestedSelection))
  }

  await startAgentDevtoolsMetadataResolution(agent, state, options, runtimeContext, requestedSelection, { force: true })
  return serializeAgentChatDevtoolsState(name, state, requestedSelection)
}

async function handleAgentChatDevtoolsFetchRequest(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  request: Request,
  state: AgentChatDevtoolsFetchState,
  options: AgentChatDevtoolsFetchHandlerOptions,
  requestOptions: AgentChatDevtoolsFetchRequestOptions = {},
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withChatDevtoolsCors(new Response(null, { status: 204 }))
  }
  if (request.method !== "POST") {
    return withChatDevtoolsCors(createJsonErrorResponse(405, "Chat DevTools bridge only accepts POST requests."))
  }

  try {
    const body = parseChatDevtoolsBridgeBody(await request.text())
    if (!body || typeof body.action !== "string") {
      return withChatDevtoolsCors(createBadRequest("Missing chat devtools action."))
    }

    const runtime = createRuntimeContext(
      request,
      undefined,
      await resolveRuntimeWaitUntil(requestOptions.waitUntil ?? options.waitUntil),
      requestOptions.cloudflare ?? options.cloudflare,
    )
    const invokerSelection = normalizeInvokerSelection(body, options.meta)
    await runWithRuntimeCloudflareEnv(runtime, async () => await startAgentDevtoolsMetadataResolution(agent, state, options, runtime, invokerSelection))

    const action = normalizeChatDevtoolsAction(body.action)
    if (action === "get-state") {
      return withChatDevtoolsCors(Response.json(serializeAgentChatDevtoolsState(agentChatDevtoolsName(agent, options), state, invokerSelection)))
    }
    if (action === "send") {
      if (!body.stream) {
        return withChatDevtoolsCors(createBadRequest("Chat DevTools sends require stream: true."))
      }
      return withChatDevtoolsCors(createChatDevtoolsStreamResponse(async (emit, signal) => {
        const finalState = await sendDevtoolsUIMessage(agent, request, state, options, requestOptions, body, (next) => {
          if (!signal.aborted) emit({ state: next, type: "state" })
        })
        if (finalState instanceof Response) {
          if (!signal.aborted) emit({ message: finalState.statusText || "Chat DevTools send failed.", type: "error" })
          return
        }
        if (!signal.aborted) emit({ state: finalState, type: "state" })
      }))
    }
    if (action === "clear") {
      const requestedSelection = normalizeInvokerSelection(body, options.meta)
      const invalidProfile = assertKnownInvokerProfile(state.metadata, requestedSelection.invokerProfileId)
      if (invalidProfile) return withChatDevtoolsCors(invalidProfile)
      state.session.thinkingFallback = null
      state.session.invokerFallback = requestedSelection.invokerFallback === true
      state.session.invokerProfileId = state.session.invokerFallback ? undefined : requestedSelection.invokerProfileId
      state.session.title = undefined
      state.session.uiMessages = []
      return withChatDevtoolsCors(Response.json(serializeAgentChatDevtoolsState(agentChatDevtoolsName(agent, options), state, requestedSelection)))
    }
    if (action === "materialize-source") {
      const result = await runWithRuntimeCloudflareEnv(runtime, async () => await materializeDevtoolsSource(agent, state, options, runtime, body))
      return withChatDevtoolsCors(result instanceof Response ? result : Response.json(result))
    }

    return withChatDevtoolsCors(createBadRequest(`Unknown chat devtools action: ${body.action}`))
  }
  catch (error) {
    return withChatDevtoolsCors(chatDevtoolsErrorResponse(error))
  }
}

export function defineAgentChatDevtoolsFetchHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChatDevtoolsFetchHandlerOptions = {},
): (request: Request, options?: AgentChatDevtoolsFetchRequestOptions) => Promise<Response> {
  const state: AgentChatDevtoolsFetchState = {
    metadata: createStaticAgentDevtoolsMetadata(agent),
    metadataStatus: chatDevtoolsMetadataStatus(agent),
    session: { uiMessages: [] },
  }
  return async (request, requestOptions = {}) => await handleAgentChatDevtoolsFetchRequest(agent, request, state, options, requestOptions)
}

async function toAgentChatFetchResponse(result: unknown): Promise<Response> {
  if (result instanceof Response) return result
  const { createUIMessageStreamResponse } = await import("ai") as { createUIMessageStreamResponse: CreateUIMessageStreamResponse }
  return createUIMessageStreamResponse({ stream: readableStreamFromResult(result) as never })
}

function agentChatFetchErrorResponse(error: unknown): Response {
  const response = toHttpErrorResponse(error)
  if (response) return response
  if (error instanceof TypeError) {
    return createJsonErrorResponse(400, error.message)
  }
  return createJsonErrorResponse(500, error instanceof Error ? error.message : "Agent chat request failed.")
}

export function defineAgentChatFetchHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChatFetchHandlerOptions = {},
): (request: Request, options?: AgentChatFetchOptions) => Promise<Response> {
  const routeOptions = resolveAgentChatFetchHandlerOptions(agent, options)
  return async (request, handlerOptions = {}) => {
    if (request.method !== "POST") {
      return createJsonErrorResponse(405, "Agent chat route only accepts POST requests.")
    }

    try {
      const body = await parseAgentChatFetchBody(request)
      const agentName = handlerOptions.agentName || "agent"
      const context = createRuntimeContext(
        request,
        undefined,
        await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
        handlerOptions.cloudflare,
      )
      const baseInput = agentChatFetchInput(body, agentName, Boolean(routeOptions.mapInput), routeOptions)
      const triggerInput = mergeAgentChatFetchInput(
        baseInput,
        await routeOptions.mapInput?.({ agentName, body, input: baseInput, request }),
      )
      const result = await runWithRuntimeCloudflareEnv(context, async () => await streamAgentTrigger(agent as never, context as never, "chat.message", triggerInput, {
        output: "ui-message-stream",
      }))
      return await toAgentChatFetchResponse(result)
    }
    catch (error) {
      return agentChatFetchErrorResponse(error)
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
    return await runWithRuntimeCloudflareEnv(context, async () => {
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
    })
  }
}
