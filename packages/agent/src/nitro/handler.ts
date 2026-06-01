import { Chat } from "chat"
import { createError, defineEventHandler, getRouterParam } from "h3"
import { createRuntimeWaitUntilController } from "@vite-hub/runtime"

import { chatWebhookRegistrations, getChatCapabilityOptions } from "../chat-trigger.ts"
import { normalizeCapabilities } from "../capability-runtime.ts"
import { resolveAgent, resolveAgentTriggers, runAgent, streamAgent, streamAgentTrigger } from "../index.ts"
import { getHttpErrorMessage, getHttpErrorStatusCode } from "../http-error.ts"
import { formatUnknownAgentMessage } from "../registry-error.ts"
import { resolveChatRuntimeValue } from "./chat-options.ts"
import { resolveChatState } from "./chat-state.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { getAgentRuntimeConfig } from "../runtime/nitro-runtime-config.ts"

import type { Adapter, Attachment, ChatConfig, Channel, IdentityContext, IdentityResolver, Message as ChatMessage, SentMessage, StateAdapter, Thread } from "chat"
import type { EventHandler, H3Event } from "h3"
import type { NitroRuntimeConfig } from "nitro/types"
import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type {
  AgentCapabilityDefinition,
  AgentChatAppOptions,
  AgentChatOptions,
  AgentHandlerOptions,
  AgentInput,
  AgentRegistryHandlerOptions,
  AgentWebhookRegistrationDefinition,
  AgentRunMetadata,
  AgentRequestBody,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeHooks,
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
type ChatConfigRecord = Omit<ChatConfig<Record<string, Adapter>>, "adapters" | "fallbackStreamingPlaceholderText" | "identity" | "state" | "transcripts" | "userName">

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

export interface AgentChatRouteBody {
  history?: AgentChatMessageTriggerInput["history"]
  id?: string
  messageId?: string
  messages?: AgentChatMessageTriggerInput["messages"]
  run?: Partial<AgentRunMetadata>
  session?: AgentChatMessageTriggerInput["session"] | string
  timeout?: number
  user?: Record<string, unknown>
}

export interface AgentChatHandlerOptions<TRuntimeContext extends AgentRuntimeContext = NitroAgentRuntimeContext> {
  inferredName?: string
  lifecycleHooks?: AgentRuntimeHooks<TRuntimeContext>
}

export interface AgentChatRegistryHandlerOptions<TRuntimeContext extends AgentRuntimeContext = NitroAgentRuntimeContext>
  extends AgentChatHandlerOptions<TRuntimeContext> {
  agent?: string
  agentParam?: string
}

interface CloudflareEnvCarrier {
  context?: {
    cloudflare?: { context?: unknown, env?: Record<string, unknown> }
    _platform?: { cloudflare?: { context?: unknown, env?: Record<string, unknown> } }
  }
  env?: Record<string, unknown>
  req?: { runtime?: { cloudflare?: { context?: unknown, env?: Record<string, unknown> } } }
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

function isReadableStream(value: unknown): value is ReadableStream<never> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { getReader?: unknown }).getReader === "function"
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

async function toUIMessageStreamResponse(value: unknown): Promise<Response> {
  if (value instanceof Response) {
    return value
  }
  if (isStreamResult(value) && value.toUIMessageStreamResponse) {
    return value.toUIMessageStreamResponse()
  }
  if (isReadableStream(value)) {
    const { createUIMessageStreamResponse } = await import("ai")
    return createUIMessageStreamResponse({ stream: value })
  }

  throw createError({
    statusCode: 500,
    statusMessage: "Agent chat route did not produce a UI message stream.",
  })
}

function createRuntimeContext(event: H3Event): NitroAgentRuntimeContext {
  const runtimeConfig = getAgentRuntimeConfig(event) as NitroAgentRuntimeConfig
  const cloudflare = getCloudflareRuntimeContext(event)
  const waitUntil = createRuntimeWaitUntilController({
    forward: task => event.waitUntil(task),
  })
  return createAgentRuntimeContext({
    ...(cloudflare ? { cloudflare } : {}),
    event,
    ...(cloudflare ? { flushWaitUntil: waitUntil.flushWaitUntil } : {}),
    request: toFetchRequest(event),
    runtime: "nitro",
    runtimeConfig,
    waitUntil: waitUntil.waitUntil,
  }) as NitroAgentRuntimeContext
}

function getCloudflareRuntimeContext(event: H3Event): AgentRuntimeContext["cloudflare"] | undefined {
  const target = event as CloudflareEnvCarrier
  const platform = target.context?._platform?.cloudflare
  const cloudflare = target.context?.cloudflare || platform || target.req?.runtime?.cloudflare
  const env = target.env || cloudflare?.env
  if (!env) return
  return {
    ...(cloudflare?.context ? { context: cloudflare.context } : {}),
    env,
  }
}

async function resolveChatAdapters(options: AgentChatOptions, context: NitroAgentRuntimeContext): Promise<Record<string, Adapter>> {
  if (!options.adapters) {
    throw new Error("[vitehub] chat() webhook handling requires chat({ adapters }).")
  }

  const input = await resolveChatRuntimeValue<Record<string, unknown>>(options.adapters, context)
  const adapters: Record<string, Adapter> = {}
  for (const [name, adapter] of Object.entries(input || {})) {
    adapters[name] = await resolveChatRuntimeValue<Adapter>(adapter, context)
  }
  return adapters
}

function defaultChatIdentity({ adapter, author }: IdentityContext): string | null {
  if (author.isMe || author.isBot === true) return null
  const adapterName = adapter.trim()
  const userId = author.userId.trim()
  return adapterName && userId && userId !== "unknown" ? `${adapterName}:${userId}` : null
}

function createChatSdkOptions(options: AgentChatOptions, adapters: Record<string, Adapter>, state: StateAdapter, agentName: string): ChatConfig<Record<string, Adapter>> {
  const {
    adapters: _adapters,
    agent: _agent,
    event: _event,
    execution: _execution,
    fallbackStreamingPlaceholderText: _fallbackStreamingPlaceholderText,
    hooks: _hooks,
    identity,
    lifecycleHooks: _lifecycleHooks,
    state: _state,
    transcripts,
    userName,
    webhooks: _webhooks,
    workflow: _workflow,
    ...chatOptions
  } = options
  const resolvedIdentity: IdentityResolver | undefined = identity || (transcripts ? defaultChatIdentity : undefined)

  return {
    ...(chatOptions as ChatConfigRecord),
    adapters,
    fallbackStreamingPlaceholderText: null,
    ...(resolvedIdentity ? { identity: resolvedIdentity } : {}),
    state,
    ...(transcripts ? { transcripts } : {}),
    userName: typeof userName === "string" && userName ? userName : agentName,
  }
}

function chatWebhookProviderMatches(registration: AgentWebhookRegistrationDefinition, platform: string): boolean {
  return registration.provider === platform || registration.id === platform
}

function requestPath(request: Request): string | undefined {
  try {
    return new URL(request.url).pathname
  }
  catch {
    return
  }
}

function selectChatWebhookRegistration(
  options: AgentChatOptions,
  platform: string,
  request: Request,
): AgentWebhookRegistrationDefinition | undefined {
  const registrations = chatWebhookRegistrations(options)?.filter(registration => chatWebhookProviderMatches(registration, platform)) || []
  if (registrations.length <= 1) return registrations[0]

  const path = requestPath(request)
  return registrations.find(registration => registration.path === path)
    || registrations.find(registration => !registration.path)
    || registrations[0]
}

function validateChatWebhookSecret(
  options: AgentChatOptions,
  platform: string,
  request: Request,
): void {
  const registration = selectChatWebhookRegistration(options, platform, request)
  if (!registration?.secretToken) return

  const header = registration.secretHeader
  if (!header) {
    throw createError({
      statusCode: 500,
      statusMessage: `Chat webhook "${platform}" defines a secret token without a secret header.`,
    })
  }

  if (request.headers.get(header) !== registration.secretToken) {
    throw createError({
      statusCode: 401,
      statusMessage: "Invalid chat webhook secret.",
    })
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

function audioAttachmentPart(attachment: Attachment, index: number): Record<string, unknown> | undefined {
  if (attachment.type !== "audio") return
  const mediaType = attachmentMediaType(attachment)
  const id = attachment.name || `audio-${index + 1}`
  const base = {
    ...(attachment.fetchMetadata ? { fetchMetadata: attachment.fetchMetadata } : {}),
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
    id,
    mediaType,
    type: "audio",
  }
  const data = attachment.data
  if (data) return { ...base, data }
  if (attachment.fetchData) return { ...base, fetchData: () => attachment.fetchData!() }
  if (attachment.url) return { ...base, url: attachment.url }
}

async function toUIMessage(message: ChatMessage, index: number): Promise<AgentChatMessageTriggerInput["messages"][number] | undefined> {
  const attachments = (await Promise.all((message.attachments || []).map(audioAttachmentPart)))
    .filter((part): part is Record<string, unknown> => Boolean(part))
  const text = typeof message.text === "string" ? message.text : ""
  const parts = [
    ...(text ? [{ text, type: "text" }] : []),
    ...attachments,
  ]
  if (!parts.length) return
  return {
    createdAt: messageCreatedAt(message),
    id: entityId(message) || `chat-message-${index}`,
    metadata: { source: "chat" },
    parts,
    role: (message as { author?: { isMe?: boolean } }).author?.isMe ? "assistant" : "user",
  }
}

function isChatTriggerMessage(message: AgentChatMessageTriggerInput["messages"][number] | undefined): message is AgentChatMessageTriggerInput["messages"][number] {
  return Boolean(message)
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
    origin: platform,
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
    if (event && typeof event === "object" && "type" in event) {
      const type = (event as { type?: unknown }).type
      if (type !== "text-delta" && type !== "text") continue
      const text = (event as { delta?: unknown, text?: unknown, textDelta?: unknown }).text
        ?? (event as { delta?: unknown, textDelta?: unknown }).textDelta
        ?? (event as { delta?: unknown }).delta
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

function resultText(result: unknown): unknown {
  return result && typeof result === "object" && typeof (result as { text?: unknown }).text === "string"
    ? (result as { text: string }).text
    : result
}

function hasPostableChatContent(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0
  }
  return value != null
}

async function postAgentResult(thread: Thread, result: unknown, placeholder?: SentMessage): Promise<void> {
  if (placeholder) {
    const final = isAsyncIterable(result)
      ? await collectStreamText(result)
      : result instanceof Response
        ? await result.clone().text()
        : resultText(result)
    if (!hasPostableChatContent(final)) {
      await placeholder.delete()
      return
    }
    await placeholder.edit(final as never)
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
  await thread.post(resultText(result) as never)
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
  const messages = (await Promise.all(sourceMessages.map(toUIMessage))).filter(isChatTriggerMessage)
  const run = createRunMetadata(platform, thread, channel, message)
  let thinkingFallback: string | undefined
  const triggerInput: AgentChatMessageTriggerInput = {
    history: options.history,
    messages,
    run,
    timeout: 90_000,
    user: {
      id: message.author?.userId,
      ...(typeof message.userKey === "string" && message.userKey ? { key: message.userKey } : {}),
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

function chatDedupeKey(adapter: Adapter, message: ChatMessage): string | undefined {
  const messageId = entityId(message)
  return messageId ? `dedupe:${adapter.name}:${messageId}` : undefined
}

async function runChatMessageWithDedupeRecovery(
  state: StateAdapter,
  adapter: Adapter,
  message: ChatMessage,
  handler: () => Promise<void>,
): Promise<void> {
  try {
    await handler()
  }
  catch (error) {
    const dedupeKey = chatDedupeKey(adapter, message)
    if (dedupeKey) await state.delete(dedupeKey).catch(() => undefined)
    throw error
  }
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

async function createAgentChatBot(agent: AgentInput<NitroAgentRuntimeContext>, context: NitroAgentRuntimeContext, agentName: string, platform: string): Promise<{ bot: Chat<Record<string, Adapter>>, options: AgentChatOptions }> {
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
  const adapter = adapters[platform]
  if (!adapter) {
    throw createError({
      statusCode: 404,
      statusMessage: `Agent "${agentName}" does not define a "${platform}" chat adapter.`,
    })
  }

  const state = await resolveChatState(options, context, agentName)
  const bot = new Chat(createChatSdkOptions(options, adapters, state, agentName))
  bot.onDirectMessage(async (thread, message, channel) => {
    await runChatMessageWithDedupeRecovery(state, adapter, message, async () => {
      await runDirectMessageHook(options, platform, thread, message, channel)
      await handleChatMessage(agent, context, platform, options, thread, message, channel)
    })
  })
  bot.onNewMention(async (thread, message) => {
    await runChatMessageWithDedupeRecovery(state, adapter, message, async () => {
      await handleChatMessage(agent, context, platform, options, thread, message, thread.channel)
    })
  })
  bot.onSubscribedMessage(async (thread, message) => {
    await runChatMessageWithDedupeRecovery(state, adapter, message, async () => {
      if (!thread.isDM) {
        await thread.unsubscribe().catch(() => undefined)
        if (!message.isMention) return
      }

      await handleChatMessage(agent, context, platform, options, thread, message, thread.channel)
    })
  })
  return { bot, options }
}

async function runChatWebhook(
  context: NitroAgentRuntimeContext,
  webhook: (request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => Promise<Response>,
): Promise<Response> {
  const response = await webhook(context.request!, {
    waitUntil: task => context.waitUntil(task),
  })
  await context.flushWaitUntil?.()
  return response
}

async function readAgentBody(request: Request): Promise<AgentRequestBody> {
  const body = await request.clone().json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentRequestBody : {}
}

async function readAgentChatRouteBody(request: Request): Promise<AgentChatRouteBody> {
  const body = await request.clone().json().catch(() => undefined)
  return typeof body === "object" && body !== null ? body as AgentChatRouteBody : {}
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function randomRunId(): string {
  return globalThis.crypto?.randomUUID?.() || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function normalizeChatRouteSession(body: AgentChatRouteBody): AgentChatMessageTriggerInput["session"] | undefined {
  if (typeof body.session === "string") {
    return body.session ? { id: body.session } : undefined
  }
  if (typeof body.session === "object" && body.session !== null) {
    return body.session
  }
  return body.id ? { id: body.id } : undefined
}

function normalizeChatAppOptions(app: AgentChatOptions["app"]): AgentChatAppOptions | undefined {
  if (!app) return
  if (typeof app === "string") return { origin: app }
  return app === true ? {} : app
}

function createChatRouteRunMetadata(
  body: AgentChatRouteBody,
  agentName: string | undefined,
  app: AgentChatAppOptions,
): AgentRunMetadata {
  const session = normalizeChatRouteSession(body)
  const message = body.messages?.at(-1)
  const run = typeof body.run === "object" && body.run !== null ? body.run : {}
  const origin = firstString(app.origin, "http")!
  const requestedOrigin = firstString(run.origin)
  if (requestedOrigin && requestedOrigin !== origin) {
    throw createError({
      statusCode: 400,
      statusMessage: `Chat App Route run.origin ${JSON.stringify(requestedOrigin)} does not match configured origin ${JSON.stringify(origin)}. Configure chat({ app }) with that origin or remove run.origin from the request.`,
    })
  }

  return {
    channelId: firstString(run.channelId, session?.id ? `http:${session.id}` : undefined, agentName ? `http:${agentName}` : undefined),
    messageId: firstString(run.messageId, body.messageId, message?.id),
    origin,
    runId: firstString(run.runId) || randomRunId(),
    threadId: firstString(run.threadId, session?.id, body.id, agentName),
  }
}

function createChatRouteTriggerInput(
  body: AgentChatRouteBody,
  agentName: string | undefined,
  app: AgentChatAppOptions,
): AgentChatMessageTriggerInput {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw createError({
      statusCode: 400,
      statusMessage: "Agent chat route requires messages.",
    })
  }

  const user = typeof body.user === "object" && body.user !== null ? body.user : undefined
  const timeout = typeof body.timeout === "number" ? body.timeout : 90_000
  const run = createChatRouteRunMetadata(body, agentName, app)
  return {
    history: body.history,
    messages: body.messages,
    run,
    session: normalizeChatRouteSession(body),
    timeout,
    user,
  }
}

function requireChatAppExposure(agent: AgentInput<NitroAgentRuntimeContext>, agentName?: string): AgentChatAppOptions {
  const options = getChatCapabilityOptions(agentCapabilityOptions(agent))
  if (!options) {
    throw createError({
      statusCode: 404,
      statusMessage: `Agent "${agentName || "default"}" does not define chat().`,
    })
  }
  if (!options.app) {
    throw createError({
      statusCode: 404,
      statusMessage: `Agent "${agentName || "default"}" does not expose a Chat App Route.`,
    })
  }
  return normalizeChatAppOptions(options.app) || {}
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

export function defineAgentChatHandler(
  agent: AgentInput<NitroAgentRuntimeContext>,
  options: AgentChatHandlerOptions<NitroAgentRuntimeContext> = {},
): EventHandler {
  const hooks = createHookRunner(options.lifecycleHooks)

  return defineEventHandler(async (event) => {
    const context = createRuntimeContext(event)
    try {
      await hooks.request(context)

      const body = await readAgentChatRouteBody(context.request!)
      if (options.lifecycleHooks?.resolved && !hasCustomRun(agent)) {
        const resolved = await resolveAgent(agent, context)
        await hooks.resolved({ ...context, agent: resolved })
      }

      const appOptions = requireChatAppExposure(agent, options.inferredName)
      const triggerInput = createChatRouteTriggerInput(body, options.inferredName, appOptions)
      const result = await streamAgentTrigger(agent, { ...context, run: triggerInput.run } as never, "chat.message", triggerInput, {
        output: "ui-message-stream",
      })
      return await toUIMessageStreamResponse(result)
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

function resolveChatRouteAgentName(event: H3Event, options: AgentChatRegistryHandlerOptions): string | undefined {
  if (options.agent) return options.agent
  const agentParam = options.agentParam || "agent"
  return getRouterParam(event, agentParam)
}

export function defineAgentChatRegistryHandler(
  agents: AgentRegistry,
  options: AgentChatRegistryHandlerOptions<NitroAgentRuntimeContext> = {},
): EventHandler {
  return defineEventHandler(async (event) => {
    const agentName = resolveChatRouteAgentName(event, options)
    if (!agentName) {
      throw createError({
        statusCode: 400,
        statusMessage: `Missing agent route param: ${options.agentParam || "agent"}`,
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
    return await defineAgentChatHandler(agent, {
      inferredName: agentName,
      lifecycleHooks: options.lifecycleHooks,
    })(event)
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
    const { bot, options: chatOptions } = await createAgentChatBot(agent, context, agentName, platform)
    const webhook = (bot.webhooks as Record<string, ((request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => Promise<Response>) | undefined>)[platform]
    if (!webhook) {
      throw createError({
        statusCode: 404,
        statusMessage: `Unknown chat platform: ${platform}`,
      })
    }
    validateChatWebhookSecret(chatOptions, platform, context.request!)
    return await runChatWebhook(context, webhook)
  })
}
