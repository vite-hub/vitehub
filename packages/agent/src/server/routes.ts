import { parseStandardSchema } from "@vite-hub/internal/http-request"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeWaitUntilController } from "@vite-hub/runtime"
import { Chat, StreamingPlan, convertEmojiPlaceholders } from "chat"

import { resolveAgentTriggerInvocation, resolveAgentTriggers, runAgent, runAgentInline, streamAgent, streamAgentTrigger } from "../index.ts"
import { hasTraceableStreamResult, isAsyncIterable, streamAgentOutputToEvents } from "../agent-output.ts"
import { toAgentPublicError } from "../agent-error.ts"
import { getAccessCapabilityOptions } from "../capabilities/access-metadata.ts"
import { CHAT_FINISH_EXTENSION_CONTEXT_KEY, getChatCapabilityOptions } from "../chat-trigger.ts"
import { chatTriggerHistoryLimit, createChatMessageTriggerInput, resolveChatTriggerHistory, uiMessagesToAgentMessages } from "../chat-message-input.ts"
import { normalizeCapabilities } from "../capability-runtime.ts"
import { deliveryArtifactAttachments } from "../delivery-artifacts.ts"
import { createAgentInvocationContextStore } from "../invocation-context.ts"
import { finalChannelOutputContextKey } from "../internal/final-channel-output.ts"
import { isAttachmentData } from "../messages.ts"
import { resolveAgentInvoker, withResolvedAgentInvokerInput } from "../invoker.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { createAgentUIMessageStreamResponse } from "../stream-output.ts"
import { isResolvedAgentTriggerHandledInvocation, verifyAgentWebhookRequest } from "../trigger-runtime.ts"
import { AgentHttpError, toHttpErrorResponse } from "../http-error.ts"
import { isWorkflowRun } from "../http-response.ts"
import { messageChannelStateContextKey } from "../internal/channels.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"

import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type { UIMessageLike } from "../chat-message-input.ts"
import type {
  AgentChatStateResolver,
  AgentCapabilityDefinition,
  AgentChannelDefinition,
  AgentChatErrorHookArgs,
  AgentChatFinishExtension,
  AgentChatMessage,
  AgentChatOptions,
  AgentDefinition,
  PublishedAgentDeliveryArtifact,
  AgentInput,
  AgentHostIdentity,
  AgentInvoker,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeName,
  AgentWaitUntil,
  AgentWebhookRegistrationDefinition,
  AgentWebhookStateResolver,
  MaybePromise,
  MaybeResolvable,
  ResolvedAgentTriggerDefinition,
} from "../types.ts"
import type { AttachmentPart, MessagePart } from "../messages.ts"
import type { Adapter, AdapterPostableMessage, Attachment, ChatConfig, Lock, Message as ChatSdkMessage, MessageContext, QueueEntry, StateAdapter, Thread, WebhookOptions } from "chat"
import type { UIMessage } from "ai"

interface ViteAgentRouteRuntimeConfig extends AgentRuntimeConfig {
  agent?: unknown
}

interface ViteAgentRouteRuntimeContext extends AgentRuntimeContext<ViteAgentRouteRuntimeConfig> {
  request: Request
  runtime: AgentRuntimeName
  runtimeConfig: ViteAgentRouteRuntimeConfig
}

interface AgentRouteRuntimeOptions {
  capabilities?: ViteAgentRouteRuntimeContext["capabilities"]
  agentIdentity?: AgentHostIdentity
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"]
  runtime?: AgentRuntimeName
  waitUntil?: AgentWaitUntil
}

export interface AgentChannelWebhookRouteOptions extends AgentRouteRuntimeOptions {
  agentName?: string
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
  webhookState?: AgentWebhookStateResolver<ViteAgentRouteRuntimeConfig>
}

export interface AgentDiscordGatewayRouteOptions extends AgentRouteRuntimeOptions {
  agentName?: string
  durationMs?: number
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
  webhookUrl: string | ((adapterName: string) => string)
}

export interface AgentChannelChatRouteRequestOptions extends AgentRouteRuntimeOptions {
  agentName?: string
}

export interface AgentChannelChatRouteStandardSchemaResultSuccess<T = unknown> {
  issues?: undefined
  value: T
}

export interface AgentChannelChatRouteStandardSchemaResultFailure {
  issues: readonly unknown[]
}

export interface AgentChannelChatRouteStandardSchemaV1<T = unknown> {
  "~standard": {
    validate: (input: unknown) => AgentChannelChatRouteStandardSchemaResultSuccess<T> | AgentChannelChatRouteStandardSchemaResultFailure | Promise<AgentChannelChatRouteStandardSchemaResultSuccess<T> | AgentChannelChatRouteStandardSchemaResultFailure>
  }
}

export interface AgentChannelChatRouteAdmissionContext<TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody> {
  agentName: string
  body: TBody
  rawBody: string
  request: Request
}

type AgentChannelChatRouteInputPatch = Omit<Partial<AgentChatMessageTriggerInput>, "run"> & {
  run?: Partial<AgentRunMetadata>
}

export type AgentChannelChatRouteTrustedInputField =
  | "meta"
  | "session"
  | "timeout"
  | "user"

export interface AgentChannelChatRouteContext<TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody, TAuth = unknown>
  extends AgentChannelChatRouteAdmissionContext<TBody> {
  auth: Exclude<TAuth, false>
  input: AgentChatMessageTriggerInput
}

export interface AgentChannelChatRouteMapInputContext<TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody, TAuth = unknown>
  extends AgentChannelChatRouteContext<TBody, TAuth> {}

export interface AgentChannelChatRouteAdmissionOptions<TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody, TAuth = unknown> {
  authenticate?: (context: AgentChannelChatRouteAdmissionContext) => MaybePromise<TAuth | false>
  body?: AgentChannelChatRouteStandardSchemaV1<TBody>
  context?: (context: AgentChannelChatRouteContext<TBody, TAuth>) => MaybePromise<AgentChannelChatRouteInputPatch | undefined | void>
}

export interface AgentChannelChatRouteInputOptions {
  trust?: readonly AgentChannelChatRouteTrustedInputField[]
}

export interface AgentChannelChatRouteHandlerOptions<TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody, TAuth = unknown> {
  admission?: AgentChannelChatRouteAdmissionOptions<TBody, TAuth>
  channelId?: string
  input?: AgentChannelChatRouteInputOptions
  mapInput?: (context: AgentChannelChatRouteMapInputContext<TBody, TAuth>) => MaybePromise<AgentChannelChatRouteInputPatch | undefined | void>
  origin?: string
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
const vercelFunctionsPackage = "@vercel/functions"

type AgentChatQueuedFinishExtension = AgentChatFinishExtension & {
  [chatFinishMessagesKey]: AgentChatMessage[]
}

interface ChatTypingRefresh {
  stop(): void
}

function createRouteError(statusCode: number, message: string): AgentHttpError {
  return new AgentHttpError(statusCode, message)
}

function createRouteBodyError(message: string): Error & { status?: number, statusCode?: number } {
  return createRouteError(400, message)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0)
}

function readableStreamFromResult(value: unknown): ReadableStream<unknown> {
  if (value instanceof ReadableStream) return value
  if (value instanceof Response && value.body) return value.body
  throw new Error("[vitehub] Agent chat trigger expected a UI message stream.")
}

function isUiMessageStreamResponse(response: Response): boolean {
  return response.headers.get("x-vercel-ai-ui-message-stream") === "v1"
}

function withCleanUiMessageStreamResponse(response: Response): Response {
  if (!response.body || !isUiMessageStreamResponse(response)) return response

  const doneFrame = new TextEncoder().encode("data: [DONE]\n\n")
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  let tail = ""
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")

  function enqueueDone(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!/(^|\r?\n)data: \[DONE]\r?\n\r?\n$/.test(tail)) {
      controller.enqueue(doneFrame)
    }
  }

  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          enqueueDone(controller)
          controller.close()
          return
        }

        tail = `${tail}${decoder.decode(result.value, { stream: true })}`.slice(-128)
        controller.enqueue(result.value)
      }
      catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    },
  }), {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
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
  if ("Deno" in globalThis) return "deno"
  const env = typeof process === "object" && process ? process.env : undefined
  if (env?.VERCEL) return "vercel"
  return "unknown"
}

function routeAgentIdentity(options: AgentRouteRuntimeOptions & { agentName?: string }): AgentHostIdentity | undefined {
  return options.agentIdentity || (options.agentName ? { name: options.agentName } : undefined)
}

function createRuntimeContext(
  request: Request,
  run: AgentRunMetadata | undefined,
  waitUntil?: AgentWaitUntil,
  cloudflare?: ViteAgentRouteRuntimeContext["cloudflare"],
  runtimeOverride?: AgentRuntimeName,
  capabilities?: ViteAgentRouteRuntimeContext["capabilities"],
  agentIdentity?: AgentHostIdentity,
): ViteAgentRouteRuntimeContext {
  const waitUntilController = createRuntimeWaitUntilController({ forward: waitUntil })
  const runtime = cloudflare ? "cloudflare-agents" : runtimeOverride || detectRuntime()
  return createAgentRuntimeContext({
    ...(capabilities ? { capabilities } : {}),
    ...(agentIdentity ? { agentIdentity } : {}),
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

function createRuntimeRequest(request: Request, body?: string): Request {
  return new Request(request.url, {
    ...(body ? { body } : {}),
    headers: request.headers,
    method: request.method,
  })
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
  const vercel = await import(/* @vite-ignore */ vercelFunctionsPackage).catch(() => undefined) as { waitUntil?: AgentWaitUntil } | undefined
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
  const capabilities = definition.capabilities || definition.__vitehubWorkspaceAgentOptions?.capabilities
  return normalizeCapabilities(Array.isArray(capabilities) ? capabilities : undefined)
}

function getAgentChatOptions(agent: unknown): AgentChatOptions | undefined {
  if (!isRecord(agent)) return undefined
  const definition = agent as AgentDefinitionWithCapabilities
  return getChatCapabilityOptions(getAgentCapabilities(agent)) || definition.chat
}

function getChannelChatOptions(
  agent: unknown,
  channelId: string | undefined,
  options: AgentChatOptions | undefined,
): AgentChatOptions | undefined {
  if (!channelId || !isRecord(agent) || !isRecord(agent.channels)) return options
  const channel = agent.channels[channelId]
  if (!isRecord(channel) || !isRecord(channel.messages)) return options
  return { ...options, ...channel.messages }
}

function hasExplicitNonStreamingMessages(agent: unknown, channelId?: string): boolean {
  if (!isRecord(agent)) return false
  if (isRecord(agent.messages) && agent.messages.stream === false) return true
  if (!isRecord(agent.channels)) return true
  if (channelId) {
    const channel = agent.channels[channelId]
    return isRecord(channel) && isRecord(channel.messages) && channel.messages.stream === false
  }
  const channels = Object.values(agent.channels)
  if (!channels.some(channel => isRecord(channel) && channel.adapter && channel.messages !== false)) return true
  return channels.some(
    channel => isRecord(channel) && isRecord(channel.messages) && channel.messages.stream === false,
  )
}

interface AgentWebhookRegistrationMatch {
  registration: AgentWebhookRegistrationDefinition
  trigger: ResolvedAgentTriggerDefinition<ViteAgentRouteRuntimeConfig>
}

function normalizeWebhookPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized
}

function webhookRegistrationPathMatches(request: Request, registration: AgentWebhookRegistrationDefinition): boolean {
  return typeof registration.path === "string"
    && normalizeWebhookPath(new URL(request.url).pathname) === normalizeWebhookPath(registration.path)
}

async function findAgentWebhookRegistration(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  request: Request,
  webhook?: string,
): Promise<AgentWebhookRegistrationMatch | undefined> {
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  const registrations: AgentWebhookRegistrationMatch[] = []
  for (const trigger of Object.values(triggers)) {
    for (const registration of trigger.webhooks || []) {
      const match = { registration, trigger: trigger as ResolvedAgentTriggerDefinition<ViteAgentRouteRuntimeConfig> }
      registrations.push(match)
    }
  }
  const pathMatches = registrations.filter(match => webhookRegistrationPathMatches(request, match.registration))
  if (pathMatches.length === 1) return pathMatches[0]
  if (pathMatches.length > 1) return undefined
  if (webhook === "" && registrations.length === 1) return registrations[0]
  if (!webhook) return undefined
  const directMatches = registrations.filter(({ registration }) =>
    registration.id === webhook || (registration.channelId === webhook && registration.id === registration.channelId))
  if (directMatches.length === 1) return directMatches[0]
  if (directMatches.length > 1) return undefined
  const providerMatches = registrations.filter(({ registration }) => registration.provider === webhook)
  return providerMatches.length === 1 ? providerMatches[0] : undefined
}

async function matchedWebhookRegistrationRequiresVerification(
  registration: AgentWebhookRegistrationDefinition,
  context: ViteAgentRouteRuntimeContext,
  requireConfiguredSecret: boolean,
): Promise<boolean> {
  if (registration.secretToken !== undefined) return await resolveMaybe(registration.secretToken, context) !== false
  return requireConfiguredSecret && registration.secretHeader !== undefined
}

function parseWebhookPayload(body: string): unknown {
  if (!body) return undefined
  try {
    return JSON.parse(body)
  }
  catch {
    return undefined
  }
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries())
}

function githubInstallationId(payload: unknown): number | undefined {
  if (!payload || typeof payload !== "object") return
  const installation = (payload as { installation?: unknown }).installation
  if (!installation || typeof installation !== "object") return
  const id = (installation as { id?: unknown }).id
  return typeof id === "number" ? id : undefined
}

async function createAgentWebhookTriggerInput(request: Request, registration: AgentWebhookRegistrationDefinition): Promise<Record<string, unknown>> {
  const body = await request.clone().text()
  const payload = parseWebhookPayload(body)
  const headers = requestHeaders(request)
  const webhook = {
    ...(registration.channelId ? { channelId: registration.channelId } : {}),
    ...(registration.id ? { id: registration.id } : {}),
    ...(registration.path ? { path: registration.path } : {}),
    provider: registration.provider,
  }
  return {
    body,
    payload,
    provider: registration.provider,
    request: {
      headers,
      method: request.method,
      url: request.url,
    },
    webhook,
    ...(registration.provider === "github"
      ? {
          github: {
            ...(headers["x-github-delivery"] ? { deliveryId: headers["x-github-delivery"] } : {}),
            ...(headers["x-github-event"] ? { event: headers["x-github-event"] } : {}),
            ...(headers["x-github-hook-id"] ? { hookId: headers["x-github-hook-id"] } : {}),
            ...(headers["x-github-hook-installation-target-id"] ? { hookInstallationTargetId: headers["x-github-hook-installation-target-id"] } : {}),
            ...(headers["x-github-hook-installation-target-type"] ? { hookInstallationTargetType: headers["x-github-hook-installation-target-type"] } : {}),
            ...(githubInstallationId(payload) ? { installationId: githubInstallationId(payload) } : {}),
          },
        }
      : {}),
  }
}

const defaultWebhookConcurrencyTtlMs = 30_000
async function resolveAgentWebhookState(
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  handlerOptions: AgentChannelWebhookRouteOptions,
): Promise<{ keyPrefix: string, state: StateAdapter } | undefined> {
  const stateOption = handlerOptions.webhookState
  if (!stateOption) return
  const agentName = routeAgentIdentity(handlerOptions)?.name || "agent"
  const origin = chatRegistrationOrigin(registration)
  const registrationId = registration.id || registration.path || origin
  const keyPrefix = `webhook:${agentName}:${origin}:${registrationId}:`
  const state = await resolveMaybe(stateOption, {
    ...context,
    webhook: {
      agentName,
      ...(registration.channelId ? { channelId: registration.channelId } : {}),
      provider: registration.provider,
      stateKeyPrefix: keyPrefix,
    },
  } as never)
  if (!state) return
  await state.connect()
  return { keyPrefix, state }
}

function webhookOwnershipKey(prefix: string, kind: "delivery" | "lease", value: string): string {
  return `${prefix}${kind}:${value}`
}

function positiveWebhookDuration(value: number | undefined, fallback: number, name: string): number {
  const duration = value ?? fallback
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TypeError(`[vitehub] Webhook delivery ownership ${name} must be a positive finite number.`)
  }
  return duration
}

async function hasActiveWorkflowRuntime(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
): Promise<boolean> {
  if (!isRecord(agent) || !isRecord(agent.runtime) || agent.runtime.kind !== "workflow") return false
  if (agent.runtime.discoveryDefault !== true) return true
  if (!context.agentIdentity || Object.values(context.capabilities || {}).some(capability => capability !== false)) return false
  try {
    return Boolean((await loadAgentWorkflowRuntimeStateModule()).getWorkflowRuntimeConfig())
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") return false
    throw error
  }
}

function startWebhookLockHeartbeat(state: StateAdapter, lock: Lock, ttlMs: number, onLost: () => void): () => void {
  const intervalMs = Math.max(1, Math.floor(ttlMs / 2))
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const extend = async () => {
    if (stopped) return
    try {
      if (!await state.extendLock(lock, ttlMs)) {
        stopped = true
        onLost()
      }
    }
    catch {
      stopped = true
      onLost()
    }
    if (!stopped) timer = setTimeout(extend, intervalMs)
  }
  timer = setTimeout(extend, intervalMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
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

function resolveDiscordAdapters(adapters: Record<string, Adapter>): [string, Adapter][] {
  return Object.entries(adapters).filter(([name, adapter]) =>
    name === "discord" || (adapter as { name?: unknown }).name === "discord")
}

async function resolveDiscordWebhookRegistration(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  adapters: Record<string, Adapter>,
  adapterName: string,
): Promise<AgentWebhookRegistrationDefinition | undefined> {
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  const matches = Object.values(triggers).flatMap(trigger =>
    (trigger.webhooks || []).filter(registration =>
      registration.provider === "discord" && resolveChatAdapterName(adapters, registration) === adapterName))
  return matches.length === 1 ? matches[0] : undefined
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

  if (result && typeof result === "object" && !isAsyncIterable(result) && !hasTraceableStreamResult(result)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, "text")
    const text = descriptor && "value" in descriptor ? descriptor.value : undefined
    if (typeof text === "string") return text.trim()
  }

  let explicitPhaseSeen = false
  let finalText = ""
  let unphasedText = ""
  for await (const event of streamAgentOutputToEvents(result)) {
    if (event.type === "text-delta") {
      if (event.phase === undefined) {
        if (!explicitPhaseSeen) unphasedText += event.text
      }
      else {
        explicitPhaseSeen = true
        unphasedText = ""
        if (event.phase === "final") finalText += event.text
      }
    }
    if (event.type === "error") {
      throw new Error(event.error)
    }
  }
  return (explicitPhaseSeen ? finalText : unphasedText).trim()
}

type ChatTextStream = AsyncIterable<string> & {
  getText: () => string
}

interface ChatTextStreamController {
  close: () => void
  discard: () => void
  fail: (error: unknown) => void
  stream: ChatTextStream
  write: (text: string) => void
}

const discordMaxContentLength = 2000
const discordLongContentModeSymbol = Symbol.for("vitehub.discord.longContent.mode")

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

function createChatTextStream(): ChatTextStreamController {
  const chunks: string[] = []
  let collected = ""
  let discarded = false
  let failure: unknown
  let finished = false
  let wake: (() => void) | undefined
  const notify = () => {
    wake?.()
    wake = undefined
  }
  const stream: ChatTextStream = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          if (chunks.length) {
            yield chunks.shift()!
            continue
          }
          if (failure !== undefined) throw failure
          if (finished) return
          await new Promise<void>(resolve => {
            wake = resolve
          })
        }
      }
      finally {
        if (!finished) {
          discarded = true
          chunks.length = 0
        }
      }
    },
    getText: () => collected,
  }
  return {
    close() {
      if (finished) return
      finished = true
      notify()
    },
    discard() {
      discarded = true
      chunks.length = 0
      finished = true
      notify()
    },
    fail(error) {
      if (finished) return
      failure = error
      notify()
    },
    stream,
    write(text) {
      if (!text || discarded || finished) return
      collected += text
      chunks.push(text)
      notify()
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

function streamAgentOutputToChatReplies(
  result: Promise<unknown>,
  options: {
    commentary: "hidden" | "message"
    onCommentary: (stream: ChatTextStream, discard: () => void) => void
    onFinal: (stream: ChatTextStream) => void
  },
): { completion: Promise<void> } {
  const commentary = createChatTextStream()
  const final = createChatTextStream()
  let commentaryStarted = false
  let finalStarted = false
  let explicitPhaseSeen = false
  const unphasedText: string[] = []
  const startFinal = () => {
    if (finalStarted) return
    finalStarted = true
    commentary.close()
    options.onFinal(final.stream)
  }
  const completion = (async () => {
    try {
      const output = await result
      const events = output instanceof Response
        ? (async function* () {
            for await (const text of streamAgentOutputToChatText(Promise.resolve(output))) {
              yield { phase: undefined, text, type: "text-delta" as const }
            }
          })()
        : streamAgentOutputToEvents(output)
      for await (const event of events) {
        if (event.type === "error") throw new Error(event.error)
        if (event.type !== "text-delta" || !event.text) continue
        if (event.phase === undefined) {
          if (!explicitPhaseSeen) unphasedText.push(event.text)
          continue
        }
        explicitPhaseSeen = true
        unphasedText.length = 0
        if (event.phase === "commentary" && !finalStarted) {
          if (options.commentary === "message" && !commentaryStarted) {
            commentaryStarted = true
            options.onCommentary(commentary.stream, commentary.discard)
          }
          if (commentaryStarted) commentary.write(event.text)
          continue
        }
        if (event.phase !== "final") continue
        startFinal()
        final.write(event.text)
      }
      if (!explicitPhaseSeen && unphasedText.length) {
        startFinal()
        for (const text of unphasedText) final.write(text)
      }
    }
    catch (error) {
      commentary.fail(error)
      final.fail(error)
      throw error
    }
    finally {
      commentary.close()
      final.close()
    }
  })()
  return { completion }
}

function chatStreamPostable(thread: Thread, response: ChatTextStream): ChatTextStream | StreamingPlan {
  return thread.adapter.stream
    ? new StreamingPlan(response, { updateIntervalMs: chatNativeStreamUpdateIntervalMs })
    : response
}

function discordLongContentMode(adapter: Adapter): "split" | undefined {
  return (adapter as Adapter & { [discordLongContentModeSymbol]?: "split" })[discordLongContentModeSymbol]
}

function splitContentAtLimit(content: string, limit: number): string[] {
  const parts: string[] = []
  let rest = content.trimEnd()
  while (rest.length > limit) {
    let index = -1
    for (const marker of ["\n\n", "\n"]) {
      index = rest.lastIndexOf(marker, limit)
      if (index > 0) {
        index += marker.length
        break
      }
    }
    if (index <= 0) {
      for (let i = limit; i > 0; i--) {
        if (/\s/.test(rest[i] || "")) {
          index = i + 1
          break
        }
      }
    }
    if (index <= 0) index = limit
    parts.push(rest.slice(0, index).trimEnd())
    rest = rest.slice(index).trimStart()
  }
  if (rest) parts.push(rest)
  return parts
}

function discordContentParts(content: string): string[] {
  if (content.length <= discordMaxContentLength) return [content]
  let total = Math.ceil(content.length / (discordMaxContentLength - " (1/1)".length))
  while (true) {
    const markerLength = ` (${total}/${total})`.length
    const parts = splitContentAtLimit(content, discordMaxContentLength - markerLength)
    if (parts.length === total) {
      return parts.map((part, index) => `${part} (${index + 1}/${total})`)
    }
    total = parts.length
  }
}

function hasChatFiles(postable: AdapterPostableMessage): boolean {
  if (typeof postable !== "object" || postable === null) return false
  const value = postable as { attachments?: unknown[], files?: unknown[] }
  return (Array.isArray(value.attachments) && value.attachments.length > 0)
    || (Array.isArray(value.files) && value.files.length > 0)
}

function renderDiscordPostable(adapter: Adapter, postable: AdapterPostableMessage): string | undefined {
  if (hasChatFiles(postable)) return undefined
  if (typeof postable === "object" && postable !== null && ("card" in postable || "type" in postable)) return undefined
  const converter = (adapter as Adapter & { formatConverter?: { renderPostable?: (message: AdapterPostableMessage) => string } }).formatConverter
  if (converter?.renderPostable) {
    return convertEmojiPlaceholders(converter.renderPostable(postable), "discord")
  }
  if (typeof postable === "string") return postable
  if (typeof postable === "object" && postable !== null && "raw" in postable && typeof postable.raw === "string") return postable.raw
  if (typeof postable === "object" && postable !== null && "markdown" in postable && typeof postable.markdown === "string") return postable.markdown
}

async function postDiscordSplitContent(thread: Thread, postable: AdapterPostableMessage): Promise<boolean> {
  if (discordLongContentMode(thread.adapter) !== "split") return false
  const rendered = renderDiscordPostable(thread.adapter, postable)
  if (!rendered || rendered.length <= discordMaxContentLength) return false
  for (const part of discordContentParts(rendered)) {
    await thread.post({ raw: part })
  }
  return true
}

async function finishDiscordSplitStream(thread: Thread, sent: unknown, markdown: string): Promise<void> {
  if (!markdown || discordLongContentMode(thread.adapter) !== "split") return
  const rendered = renderDiscordPostable(thread.adapter, { markdown })
  if (!rendered || rendered.length <= discordMaxContentLength) return
  const [first, ...rest] = discordContentParts(rendered)
  if (first && sent && typeof sent === "object" && "edit" in sent && typeof sent.edit === "function") {
    await sent.edit({ attachments: [], raw: first })
  }
  else if (first) {
    await thread.post({ raw: first })
  }
  for (const part of rest) {
    await thread.post({ raw: part })
  }
}

function sentMessageText(sent: unknown): string {
  return sent && typeof sent === "object" && "text" in sent && typeof sent.text === "string" ? sent.text : ""
}

async function postChatStream(
  thread: Thread,
  response: ChatTextStream,
  fallback: string | null | undefined,
  waitUntil: AgentWaitUntil,
): Promise<void> {
  let sent: unknown
  if (fallback === undefined) {
    sent = await thread.post(chatStreamPostable(thread, response) as never)
    await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent))
    return
  }

  if (thread.adapter.stream) {
    const adapter = thread.adapter
    const nativeStream = adapter.stream!.bind(adapter)
    const placeholder = fallback === null
      ? Promise.resolve(undefined)
      : adapter.postMessage(thread.id, fallback).catch(() => undefined)
    let cleared = false
    let clearing: Promise<void> | undefined
    let clearRequested = false
    const clearPlaceholder = async () => {
      if (cleared) return
      if (clearing) return clearing
      clearing = placeholder.then(async (message) => {
        if (!message?.id) return
        await adapter.deleteMessage(message.threadId || thread.id, message.id)
        cleared = true
      }).catch(() => undefined).finally(() => {
        clearing = undefined
      })
      return clearing
    }
    const finishPlaceholder = () => {
      waitUntil(clearPlaceholder().then(() => cleared ? undefined : clearPlaceholder()))
    }
    const nativeResponse: ChatTextStream = {
      getText: response.getText,
      async *[Symbol.asyncIterator]() {
        for await (const chunk of response) {
          // Consuming a native stream chunk means the adapter has visible output to replace the fallback.
          if (!clearRequested) {
            clearRequested = true
            void clearPlaceholder()
          }
          yield chunk
        }
      },
    }
    const chatThread = thread as Thread & { _adapter?: Adapter, _fallbackStreamingPlaceholderText?: string | null }
    const previousAdapter = chatThread._adapter
    const previousFallback = chatThread._fallbackStreamingPlaceholderText
    // ponytail: Chat SDK does not expose whether native streaming was accepted.
    chatThread._adapter = new Proxy(adapter, {
      get(target, property) {
        if (property === "stream") {
          return async (...args: Parameters<typeof nativeStream>) => {
            const raw = await nativeStream(...args)
            return raw
          }
        }
        if (property === "postMessage" && fallback !== null) {
          return async (...args: Parameters<Adapter["postMessage"]>) => {
            if (args[0] === thread.id && args[1] === fallback) {
              const message = await placeholder
              if (message) {
                cleared = true
                return message
              }
            }
            return adapter.postMessage(...args)
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    chatThread._fallbackStreamingPlaceholderText = fallback
    try {
      sent = await thread.post(chatStreamPostable(thread, nativeResponse) as never)
      await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent))
    }
    finally {
      chatThread._adapter = previousAdapter
      chatThread._fallbackStreamingPlaceholderText = previousFallback
      finishPlaceholder()
    }
    return
  }

  // ponytail: Chat SDK has no per-stream fallback option; replace this when it exposes one.
  const chatThread = thread as Thread & { _fallbackStreamingPlaceholderText?: string | null }
  const previous = chatThread._fallbackStreamingPlaceholderText
  chatThread._fallbackStreamingPlaceholderText = fallback
  try {
    sent = await thread.post(chatStreamPostable(thread, response) as never)
    await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent))
  }
  finally {
    chatThread._fallbackStreamingPlaceholderText = previous
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

function withChatStateScope(state: StateAdapter, channelPrefix: string, agentPrefix: string): StateAdapter {
  const key = (value: string) => `${value.startsWith("transcripts:user:") ? agentPrefix : channelPrefix}${value}`
  const lock = (value: Lock) => ({ ...value, threadId: key(value.threadId) })
  return {
    async acquireLock(threadId, ttlMs) {
      const acquired = await state.acquireLock(key(threadId), ttlMs)
      return acquired ? { ...acquired, threadId } : null
    },
    appendToList: (listKey, value, options) => state.appendToList(key(listKey), value, options),
    connect: () => state.connect(),
    delete: cacheKey => state.delete(key(cacheKey)),
    dequeue: threadId => state.dequeue(key(threadId)),
    disconnect: () => state.disconnect(),
    enqueue: (threadId, entry, maxSize) => state.enqueue(key(threadId), entry, maxSize),
    extendLock: (value, ttlMs) => state.extendLock(lock(value), ttlMs),
    forceReleaseLock: threadId => state.forceReleaseLock(key(threadId)),
    get: cacheKey => state.get(key(cacheKey)),
    getList: listKey => state.getList(key(listKey)),
    isSubscribed: threadId => state.isSubscribed(key(threadId)),
    queueDepth: threadId => state.queueDepth(key(threadId)),
    releaseLock: value => state.releaseLock(lock(value)),
    set: (cacheKey, value, ttlMs) => state.set(key(cacheKey), value, ttlMs),
    setIfNotExists: (cacheKey, value, ttlMs) => state.setIfNotExists(key(cacheKey), value, ttlMs),
    subscribe: threadId => state.subscribe(key(threadId)),
    unsubscribe: threadId => state.unsubscribe(key(threadId)),
  }
}

function chatStateOwnsScope(state: AgentChatStateResolver<ViteAgentRouteRuntimeConfig> | undefined): boolean {
  if (typeof state === "function") {
    return (state as typeof state & { ownsScope?: boolean }).ownsScope !== false
  }
  return isRecord(state) && typeof state.resolve === "function"
}

async function resolveChatState(
  options: AgentChatOptions | undefined,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  handlerOptions: AgentChannelWebhookRouteOptions,
): Promise<{ state: StateAdapter, titleKeyPrefix: string }> {
  const agentName = routeAgentIdentity(handlerOptions)?.name || "agent"
  const origin = chatRegistrationOrigin(registration)
  const agentKeyPrefix = `chat:${agentName}:`
  const stateKeyPrefix = `${agentKeyPrefix}${origin}:`
  const state = await resolveMaybe(
    (options?.state ?? handlerOptions.state) as AgentChatStateResolver<ViteAgentRouteRuntimeConfig> | undefined,
    {
      ...context,
      chat: {
        agentName,
        stateKeyPrefix,
      },
    } as never,
  )
  if (!state) {
    return {
      state: withChatStateScope(getInMemoryChatState(agentName), stateKeyPrefix, agentKeyPrefix),
      titleKeyPrefix: "",
    }
  }
  if (options?.state === undefined && !chatStateOwnsScope(handlerOptions.state)) {
    return {
      state: withChatStateScope(state, stateKeyPrefix, agentKeyPrefix),
      titleKeyPrefix: "",
    }
  }
  return { state, titleKeyPrefix: stateKeyPrefix }
}

function chatSdkOption<T>(options: AgentChatOptions | undefined, key: string): T | undefined {
  return isRecord(options) ? options[key] as T | undefined : undefined
}

function createChatSdkConfig(
  adapterName: string,
  adapter: Adapter,
  state: StateAdapter,
  options: AgentChatOptions | undefined,
): ChatConfig {
  const fallbackStreamingPlaceholderText = typeof options?.fallbackStreamingPlaceholderText === "string"
    ? options.fallbackStreamingPlaceholderText
    : options?.fallbackStreamingPlaceholderText === null ? null : undefined
  const identity: ChatConfig["identity"] = options?.identity ?? (options?.transcripts
    ? ({ author }) => author.isBot === true ? null : `${adapterName}:${author.userId}`
    : undefined)
  return objectWithoutUndefined({
    adapters: { [adapterName]: adapter },
    concurrency: chatSdkOption<ChatConfig["concurrency"]>(options, "concurrency"),
    dedupeTtlMs: chatSdkOption<number>(options, "dedupeTtlMs"),
    fallbackStreamingPlaceholderText,
    identity,
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

const chatTextAttachmentMaxBytes = 8 * 1024 * 1024
const textAttachmentExtensions = new Set(["csv", "json", "log", "md", "txt", "yaml", "yml"])
const textAttachmentMimeTypes = new Set(["application/json", "application/x-yaml", "application/yaml", "text/csv"])
const chatTextAttachmentOversizeMessage = `[vitehub] Chat text attachment exceeds ${chatTextAttachmentMaxBytes} bytes.`

function isTextAttachment(attachment: Attachment): boolean {
  if (attachment.type !== "file") return false
  const mimeType = typeof attachment.mimeType === "string"
    ? attachment.mimeType.split(";")[0]?.trim().toLowerCase()
    : undefined
  if (mimeType?.startsWith("text/") || (mimeType && textAttachmentMimeTypes.has(mimeType)) || mimeType?.endsWith("+json") || mimeType?.endsWith("+yaml")) {
    return true
  }
  const extension = attachment.name?.split(".").pop()?.toLowerCase()
  return !!extension && textAttachmentExtensions.has(extension)
}

function checkedTextAttachmentBytes(value: unknown, options: { rejectOversizedTextAttachments?: boolean } = {}): Uint8Array | undefined {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : value instanceof Uint8Array ? value : undefined
  if (!bytes) return
  if (bytes.byteLength > chatTextAttachmentMaxBytes) {
    if (!options.rejectOversizedTextAttachments) return
    throw new Error(chatTextAttachmentOversizeMessage)
  }
  return bytes
}

function isTextAttachmentOversizeError(error: unknown): boolean {
  return error instanceof Error && error.message === chatTextAttachmentOversizeMessage
}

async function fetchTextAttachmentBytes(url: string, options: { rejectOversizedTextAttachments?: boolean } = {}): Promise<Uint8Array | undefined> {
  const response = await fetch(url)
  if (!response.ok) return
  const contentLengthHeader = response.headers.get("content-length")
  const contentLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader)
  if (typeof contentLength === "number" && Number.isFinite(contentLength) && contentLength > chatTextAttachmentMaxBytes) {
    if (!options.rejectOversizedTextAttachments) return
    throw new Error(chatTextAttachmentOversizeMessage)
  }
  if (!response.body) {
    return checkedTextAttachmentBytes(await response.arrayBuffer(), options)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
    byteLength += chunk.byteLength
    if (byteLength > chatTextAttachmentMaxBytes) {
      await reader.cancel().catch(() => undefined)
      if (!options.rejectOversizedTextAttachments) return
      throw new Error(chatTextAttachmentOversizeMessage)
    }
    chunks.push(chunk)
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function textAttachmentBytes(attachment: Attachment, options: { rejectOversizedTextAttachments?: boolean } = {}): Promise<Uint8Array | undefined> {
  if (typeof attachment.size === "number" && attachment.size > chatTextAttachmentMaxBytes) {
    if (!options.rejectOversizedTextAttachments) return
    throw new Error(chatTextAttachmentOversizeMessage)
  }
  if (typeof attachment.fetchData === "function") {
    try {
      return checkedTextAttachmentBytes(await attachment.fetchData(), options)
    }
    catch (error) {
      if (isTextAttachmentOversizeError(error)) throw error
      return undefined
    }
  }
  if (attachment.data instanceof Blob) {
    return checkedTextAttachmentBytes(await attachment.data.arrayBuffer(), options)
  }
  const bytes = checkedTextAttachmentBytes(attachment.data, options)
  if (bytes) return bytes
  if (typeof attachment.url !== "string" || !attachment.url) return undefined
  try {
    return await fetchTextAttachmentBytes(attachment.url, options)
  }
  catch (error) {
    if (isTextAttachmentOversizeError(error)) throw error
    return undefined
  }
}

async function textPartFromAttachment(attachment: Attachment, index: number, options: { rejectOversizedTextAttachments?: boolean } = {}): Promise<MessagePart | undefined> {
  if (!isTextAttachment(attachment)) return undefined
  const bytes = await textAttachmentBytes(attachment, options)
  if (!bytes?.byteLength) return undefined
  const name = attachment.name || `attachment-${index + 1}`
  return {
    id: `attachment-${index + 1}`,
    text: `\n\nText attachment (${name}):\n\n${new TextDecoder().decode(bytes).trimEnd()}`,
    type: "text",
  }
}

function attachmentPartFromAttachment(attachment: Attachment, index: number): AttachmentPart | undefined {
  const mediaType = typeof attachment.mimeType === "string" && attachment.mimeType
    ? attachment.mimeType
    : undefined
  const type = mediaType?.startsWith("audio/") || (attachment.type === "audio" && !mediaType)
    ? "audio"
    : mediaType?.startsWith("image/")
      ? "image"
      : "file"
  const data = isAttachmentData(attachment.data) ? attachment.data : undefined
  const fetchData = typeof attachment.fetchData === "function"
    ? async () => {
        const value = await attachment.fetchData?.()
        const resolved = isAttachmentData(value) ? value : undefined
        if (!resolved) {
          throw new Error("[vitehub] Chat attachment fetchData() did not return supported attachment data.")
        }
        return resolved
      }
    : undefined
  const url = typeof attachment.url === "string" && attachment.url ? attachment.url : undefined
  if (!data && !fetchData && !url) return undefined
  const part = objectWithoutUndefined({
    data,
    fetchData,
    fetchMetadata: attachment.fetchMetadata,
    id: `attachment-${index + 1}`,
    mediaType: mediaType ?? (type === "audio" ? "audio/ogg" : "application/octet-stream"),
    name: attachment.name,
    size: attachment.size,
    type,
    url,
  })
  return part as AttachmentPart
}

function attachmentFallbackLabel(attachment: Attachment): string {
  if (typeof attachment.type === "string" && attachment.type) return attachment.type
  if (typeof attachment.mimeType === "string" && attachment.mimeType) return attachment.mimeType
  return "file"
}

function attachmentFallbackText(attachments: Attachment[]): string {
  if (!attachments.length) return ""
  const labels = attachments.map(attachmentFallbackLabel)
  if (labels.length === 1) {
    const article = /^[aeiou]/i.test(labels[0] ?? "") ? "an" : "a"
    return `Sent ${article} ${labels[0]} attachment.`
  }
  const counts = new Map<string, number>()
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const summary = [...counts.entries()]
    .map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`)
    .join(", ")
  return `Sent attachments: ${summary}.`
}

async function chatMessageParts(message: ChatSdkMessage, options: { rejectOversizedTextAttachments?: boolean } = {}): Promise<MessagePart[]> {
  const parts: MessagePart[] = []
  if (message.text) {
    parts.push({ id: "text-0", text: message.text, type: "text" })
  }
  for (const [index, attachment] of message.attachments.entries()) {
    const textPart = await textPartFromAttachment(attachment, index, options)
    if (textPart) {
      parts.push(textPart)
      continue
    }
    const attachmentPart = attachmentPartFromAttachment(attachment, index)
    if (attachmentPart) parts.push(attachmentPart)
  }
  if (!parts.length) {
    const text = attachmentFallbackText(message.attachments)
    if (text) parts.push({ id: "text-0", text, type: "text" })
  }
  return parts
}

function chatMessageMetadata(thread: Thread, message: ChatSdkMessage, messageContext?: MessageContext): Record<string, unknown> | undefined {
  const platformChannelId = thread.adapter.channelIdFromThreadId(message.threadId)
  return objectWithoutUndefined({
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
}

async function chatSdkMessageToUiMessage(
  message: ChatSdkMessage,
  metadata?: Record<string, unknown>,
  options?: { rejectOversizedTextAttachments?: boolean },
): Promise<UIMessageLike> {
  return {
    createdAt: isoDate(message.metadata.dateSent),
    id: message.id,
    ...(metadata ? { metadata } : {}),
    parts: await chatMessageParts(message, options),
    role: message.author.isMe ? "assistant" : "user",
  }
}

function chatAuthorizationUiMessage(thread: Thread, message: ChatSdkMessage, messageContext?: MessageContext): UIMessageLike {
  const metadata = chatMessageMetadata(thread, message, messageContext)
  return {
    createdAt: isoDate(message.metadata.dateSent),
    id: message.id,
    ...(metadata ? { metadata } : {}),
    parts: message.text ? [{ id: "text-0", text: message.text, type: "text" }] : [],
    role: message.author.isMe ? "assistant" : "user",
  }
}

interface ChatThreadHistoryCache {
  getMessages(threadId: string, limit?: number): Promise<ChatSdkMessage[]>
}

function chatThreadHistoryCache(thread: Thread): ChatThreadHistoryCache | undefined {
  const history = (thread as { _threadHistory?: unknown })._threadHistory
  if (!history || typeof history !== "object") return
  const getMessages = (history as { getMessages?: unknown }).getMessages
  if (typeof getMessages !== "function") return
  return history as ChatThreadHistoryCache
}

async function durableChatThreadMessages(thread: Thread, limit: number): Promise<ChatSdkMessage[]> {
  try {
    return await chatThreadHistoryCache(thread)?.getMessages(thread.id, limit) ?? []
  }
  catch {
    return []
  }
}

async function chatTriggerMessages(
  thread: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
  messageContext?: MessageContext,
): Promise<UIMessageLike[]> {
  const current = await chatSdkMessageToUiMessage(message, chatMessageMetadata(thread, message, messageContext), {
    rejectOversizedTextAttachments: true,
  })
  const limit = chatTriggerHistoryLimit(resolveChatTriggerHistory(options))
  if (!limit) return [current]

  const fetchedNewestFirst: UIMessageLike[] = []
  try {
    for await (const item of thread.messages) {
      fetchedNewestFirst.push(item.id && message.id && item.id === message.id ? current : await chatSdkMessageToUiMessage(item))
      if (fetchedNewestFirst.length >= limit) break
    }
  } catch {}

  const durable = await durableChatThreadMessages(thread, limit)
  const messages = [
    ...(await Promise.all(durable.map(item => item.id && message.id && item.id === message.id ? current : chatSdkMessageToUiMessage(item)))),
    ...fetchedNewestFirst.slice().reverse(),
  ].reduce<UIMessageLike[]>((deduped, item) => {
    if (!item.id) {
      deduped.push(item)
      return deduped
    }
    const existing = deduped.findIndex(message => message.id === item.id)
    if (existing === -1) deduped.push(item)
    else deduped[existing] = item
    return deduped
  }, [])

  if (!current.id || !messages.some(item => item.id === current.id)) {
    messages.push(current)
  }
  return messages.slice(-limit)
}

function createChatTriggerInput(
  provider: string,
  thread: Thread,
  message: ChatSdkMessage,
  messages: UIMessageLike[],
  messageContext?: MessageContext,
  channelId?: string,
): AgentChatMessageTriggerInput {
  const platformChannelId = thread.adapter.channelIdFromThreadId(message.threadId)
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
    messages,
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

function chatMessageDeliveryArtifacts(message: AgentChatMessage): readonly PublishedAgentDeliveryArtifact[] {
  const artifacts = (message as { artifacts?: unknown }).artifacts
  return Array.isArray(artifacts) ? artifacts as readonly PublishedAgentDeliveryArtifact[] : []
}

async function postChatMessage(thread: Thread, message: AgentChatMessage): Promise<void> {
  if (typeof message !== "object" || message === null) {
    if (await postDiscordSplitContent(thread, message)) return
    await thread.post(message)
    return
  }

  const attachments = deliveryArtifactAttachments(chatMessageDeliveryArtifacts(message))
  if (!attachments.length) {
    const postable = isTextChatMessage(message) ? message.text : message as AdapterPostableMessage
    if (await postDiscordSplitContent(thread, postable)) return
    await thread.post(postable)
    return
  }

  if (isTextChatMessage(message)) {
    await thread.post({ attachments, raw: message.text })
    return
  }

  const { artifacts: _artifacts, ...postable } = message as Exclude<AgentChatMessage, string | { text: string }> & {
    artifacts?: readonly PublishedAgentDeliveryArtifact[]
    attachments?: unknown
  }
  await thread.post({
    ...postable,
    attachments: [
      ...(Array.isArray(postable.attachments) ? postable.attachments as Attachment[] : []),
      ...attachments,
    ],
  } as AdapterPostableMessage)
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
  const publicError = toAgentPublicError(args.error, "http")
  if (publicError.code === "RATE_LIMIT_REJECTED") return publicError.error
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
      actor: invoker,
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
  state: { keyPrefix: string, state: StateAdapter },
  messageContext?: MessageContext,
): Promise<void> {
  let input: AgentChatMessageTriggerInput | undefined
  let run: AgentRunMetadata | undefined
  let typing: ChatTypingRefresh | undefined
  try {
    input = createChatTriggerInput(chatRegistrationOrigin(registration), thread, message, [chatAuthorizationUiMessage(thread, message, messageContext)], messageContext, registration.channelId)
    const authorizationInput = createChatMessageTriggerInput(options || {}, input).input
    const invoker = await isChatMessageAuthorized(agent, context, registration, thread, message, authorizationInput, input.run, messageContext)
    if (!invoker) return

    const messages = await chatTriggerMessages(thread, message, options, messageContext)
    const currentMessage = message.id
      ? messages.find(item => item.id === message.id)
      : messages.at(-1)
    if (!currentMessage || !Array.isArray(currentMessage.parts) || currentMessage.parts.length === 0) return
    input = { ...input, messages }
    const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, "chat.message", input)
    if (isResolvedAgentTriggerHandledInvocation(invocation)) return

    const streamsPhasedReplies = options?.stream !== false || options?.commentary !== undefined
    typing = streamsPhasedReplies ? startChatTypingRefresh(thread, context) : undefined
    run = invocation.run
    const runContext = {
      ...context,
      ...(invocation.run ? { run: invocation.run } : {}),
    }
    const chatFinish = createChatFinishExtension(input, registration)
    const invocationInput = withChatFinishExtension(withResolvedAgentInvokerInput({
      ...(invocation.input as AgentRunInput),
      context: {
        ...(invocation.input as AgentRunInput).context,
        [messageChannelStateContextKey]: state,
        ...(options?.stream === false ? { [finalChannelOutputContextKey]: true } : {}),
      },
    }, invoker), chatFinish)
    if (!streamsPhasedReplies) {
      const result = await runAgentInline(agent as never, runContext as never, invocationInput as never)
      const text = await collectAgentOutput(result)
      if (text) {
        if (!await postDiscordSplitContent(thread, { markdown: text })) {
          await thread.post({ markdown: text })
        }
      }
      await flushChatFinishExtensionMessages(thread, chatFinish)
    }
    else {
      const result = streamAgent(agent as never, runContext as never, invocationInput as never, {
        output: "events",
      })
      const thinkingFallback = invocation.metadata?.thinkingFallback
      try {
        if (options?.stream === true || options?.commentary === undefined) {
          await postChatStream(
            thread,
            streamAgentOutputToChatText(result),
            typeof thinkingFallback === "string" || thinkingFallback === null ? thinkingFallback : undefined,
            context.waitUntil,
          )
        }
        else {
          let finalDelivery: Promise<void> | undefined
          let finalDeliveryError: unknown
          const replies = streamAgentOutputToChatReplies(result, {
            commentary: options.commentary,
            onCommentary(response, discard) {
              const delivery = postChatStream(thread, response, undefined, context.waitUntil)
                .catch(() => discard())
              context.waitUntil(delivery)
            },
            onFinal(response) {
              finalDelivery = postChatStream(
                thread,
                response,
                typeof thinkingFallback === "string" || thinkingFallback === null ? thinkingFallback : undefined,
                context.waitUntil,
              ).catch((error) => {
                finalDeliveryError = error
              })
            },
          })
          let streamError: unknown
          await replies.completion.catch((error) => {
            streamError = error
          })
          await finalDelivery
          if (streamError !== undefined) throw streamError
          if (finalDeliveryError !== undefined) throw finalDeliveryError
        }
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
  handlerOptions: AgentChannelWebhookRouteOptions,
): Promise<(request: Request, webhookOptions: WebhookOptions) => Promise<Response>> {
  const resolvedState = await resolveChatState(options, context, registration, handlerOptions)
  const chat = new Chat(createChatSdkConfig(
    adapterName,
    adapter,
    resolvedState.state,
    options,
  ))
  const state = { keyPrefix: resolvedState.titleKeyPrefix, state: resolvedState.state }

  chat.onDirectMessage((thread, message, _channel, messageContext) =>
    handleChatSdkMessage(agent, context, registration, thread, message, options, state, messageContext))
  chat.onNewMention(async (thread, message, messageContext) => {
    await thread.subscribe().catch(() => undefined)
    await handleChatSdkMessage(agent, context, registration, thread, message, options, state, messageContext)
  })
  chat.onSubscribedMessage((thread, message, messageContext) =>
    handleChatSdkMessage(agent, context, registration, thread, message, options, state, messageContext))

  const handler = chat.webhooks[adapterName]
  if (!handler) {
    throw new Error(`[vitehub] Chat adapter "${adapterName}" did not expose a webhook handler.`)
  }
  return handler
}

export type AgentChannelChatRouteBody = {
  id?: string
  invoker?: unknown
  invokerProfileId?: unknown
  messageId?: string
  meta?: unknown
  messages?: unknown
  run?: unknown
  session?: unknown
  timeout?: unknown
  trigger?: string
  triggerHistory?: AgentChatMessageTriggerInput["triggerHistory"]
  user?: unknown
}

function createHttpChatRunMetadata(
  agentName: string,
  body: AgentChannelChatRouteBody,
  messages: UIMessage[],
  options: Pick<AgentChannelChatRouteHandlerOptions, "channelId" | "origin"> = {},
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

async function parseAgentChannelChatRouteBody(request: Request): Promise<{ body: AgentChannelChatRouteBody, rawBody: string }> {
  const raw = await request.text()
  if (!raw.trim()) throw createRouteBodyError("Missing agent chat payload.")
  try {
    const body = JSON.parse(raw) as AgentChannelChatRouteBody
    if (!isRecord(body)) throw createRouteBodyError("Agent chat payload must be a JSON object.")
    return { body, rawBody: raw }
  }
  catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error
    throw createRouteBodyError("Malformed agent chat payload.")
  }
}

async function parseAgentChannelChatRouteAdmissionBody<TBody extends AgentChannelChatRouteBody>(
  body: AgentChannelChatRouteBody,
  schema: AgentChannelChatRouteStandardSchemaV1<TBody> | undefined,
): Promise<TBody> {
  if (!schema) return body as TBody
  try {
    return await parseStandardSchema(schema, body, "agent chat route body")
  }
  catch (error) {
    throw createRouteBodyError(error instanceof Error ? error.message : "Invalid agent chat route body.")
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

function agentChannelChatRouteInput(
  body: AgentChannelChatRouteBody,
  agentName: string,
  allowTrustedInput = false,
  options: Pick<AgentChannelChatRouteHandlerOptions, "channelId" | "origin"> = {},
): AgentChatMessageTriggerInput {
  if (!Array.isArray(body.messages)) {
    throw createRouteBodyError("Agent chat payload requires a messages array.")
  }
  if (!allowTrustedInput && ("invoker" in body || "invokerProfileId" in body || "meta" in body || "run" in body || "session" in body || "timeout" in body || "user" in body)) {
    throw createRouteBodyError("Agent chat route identity must be derived server-side with defineAgent({ invoker }).")
  }
  const messages = body.messages as UIMessage[]
  return {
    messages,
    run: createHttpChatRunMetadata(agentName, body, messages, options),
    ...(body.triggerHistory !== undefined ? { triggerHistory: body.triggerHistory } : {}),
  }
}

function agentChannelRouteOptions(channelId: string, channel: AgentChannelDefinition): AgentChannelChatRouteHandlerOptions | undefined {
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
    } as AgentChannelChatRouteHandlerOptions
  }
  throw new TypeError(`[vitehub] Channel "${channelId}" route must be true or an agent chat route options object.`)
}

export function hasChannelChatRoute(agent: AgentInput<ViteAgentRouteRuntimeContext>): boolean {
  if (!isRecord(agent) || !isRecord(agent.channels) || Array.isArray(agent.channels)) return false
  return Object.values(agent.channels).some(
    channel => isRecord(channel) && channel.route !== undefined && channel.route !== false,
  )
}

function resolveAgentChannelChatRouteHandlerOptions(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChannelChatRouteHandlerOptions = {},
): AgentChannelChatRouteHandlerOptions {
  const channels = isRecord(agent) && isRecord(agent.channels) && !Array.isArray(agent.channels)
    ? agent.channels as Record<string, AgentChannelDefinition>
    : {}
  const routeEntries = Object.entries(channels)
    .map(([channelId, channel]) => [channelId, agentChannelRouteOptions(channelId, channel)] as const)
    .filter((entry): entry is readonly [string, AgentChannelChatRouteHandlerOptions] => entry[1] !== undefined)

  if (routeEntries.length > 1) {
    throw new TypeError("[vitehub] createChannelChatRouteHandler() found multiple route-enabled Channels. Keep one route-enabled Channel per generated chat route.")
  }

  const channelOptions = routeEntries[0]?.[1]
  return {
    ...channelOptions,
    ...options,
    admission: options.admission ?? channelOptions?.admission,
    input: options.input ?? channelOptions?.input,
    mapInput: options.mapInput ?? channelOptions?.mapInput,
  }
}

function trustAgentChannelChatRouteInput(
  body: AgentChannelChatRouteBody,
  options: AgentChannelChatRouteInputOptions | undefined,
): AgentChannelChatRouteInputPatch | undefined {
  if (!options?.trust?.length) return undefined
  const patch: AgentChannelChatRouteInputPatch = {}
  for (const field of options.trust) {
    if (field === "meta" && body.meta !== undefined) patch.meta = optionalBodyRecord(body.meta, "meta")
    else if (field === "session" && body.session !== undefined) patch.session = optionalBodyRecord(body.session, "session") as AgentChatMessageTriggerInput["session"]
    else if (field === "timeout" && typeof body.timeout === "number" && Number.isFinite(body.timeout) && body.timeout > 0) patch.timeout = body.timeout
    else if (field === "user" && body.user !== undefined) patch.user = optionalBodyRecord(body.user, "user")
  }
  return Object.keys(patch).length ? patch : undefined
}

function mergeAgentChannelChatRouteInput(
  input: AgentChatMessageTriggerInput,
  patch: AgentChannelChatRouteInputPatch | undefined | void,
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

async function toAgentChatFetchResponse(result: unknown): Promise<Response> {
  if (result instanceof Response) return withCleanUiMessageStreamResponse(result)
  return createAgentUIMessageStreamResponse({ stream: readableStreamFromResult(result) })
}

function agentChatFetchErrorResponse(error: unknown): Response {
  const response = toHttpErrorResponse(error)
  if (response) return response
  return toHttpErrorResponse(error, error instanceof TypeError ? 400 : 500)!
}

export function createChannelChatRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChannelChatRouteHandlerOptions = {},
): (request: Request, options?: AgentChannelChatRouteRequestOptions) => Promise<Response> {
  const routeOptions = resolveAgentChannelChatRouteHandlerOptions(agent, options)
  return async (request, handlerOptions = {}) => {
    if (request.method !== "POST") {
      return createJsonErrorResponse(405, "Agent chat route only accepts POST requests.")
    }

    try {
      const parsed = await parseAgentChannelChatRouteBody(request)
      const agentIdentity = routeAgentIdentity(handlerOptions)
      const agentName = agentIdentity?.name || "agent"
      const auth = await routeOptions.admission?.authenticate?.({ agentName, body: parsed.body, rawBody: parsed.rawBody, request })
      if (auth === false) throw createRouteError(401, "Agent chat route request was not admitted.")
      const body = await parseAgentChannelChatRouteAdmissionBody(parsed.body, routeOptions.admission?.body)
      const context = createRuntimeContext(
        createRuntimeRequest(request, parsed.rawBody),
        undefined,
        await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
        handlerOptions.cloudflare,
        handlerOptions.runtime,
        handlerOptions.capabilities,
        agentIdentity,
      )
      const trustInput = Boolean(routeOptions.admission?.authenticate && routeOptions.input?.trust?.length)
      const baseInput = agentChannelChatRouteInput(body, agentName, Boolean(trustInput || routeOptions.admission?.context || routeOptions.mapInput), routeOptions)
      const trustedInput = mergeAgentChannelChatRouteInput(
        baseInput,
        trustInput ? trustAgentChannelChatRouteInput(body, routeOptions.input) : undefined,
      )
      const inputContext = { agentName, auth: auth as never, body, input: trustedInput, rawBody: parsed.rawBody, request }
      const admittedInput = mergeAgentChannelChatRouteInput(
        trustedInput,
        await routeOptions.admission?.context?.(inputContext),
      )
      const triggerInput = mergeAgentChannelChatRouteInput(
        admittedInput,
        await routeOptions.mapInput?.({ ...inputContext, input: admittedInput }),
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

export function createChannelWebhookRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, webhook?: string, options?: AgentChannelWebhookRouteOptions) => Promise<Response> {
  return async (request, webhook, handlerOptions = {}) => {
    if (request.method !== "POST") {
      return createJsonErrorResponse(405, "Agent webhook route only accepts POST requests.")
    }

    const webhookId = webhook === undefined ? fallbackWebhookFromRequest(request) : webhook
    if (webhookId === undefined) {
      return createBadRequest("Agent webhook route requires a webhook id.")
    }

    const waitUntil = await resolveRuntimeWaitUntil(handlerOptions.waitUntil)
    const context = createRuntimeContext(
      request,
      undefined,
      waitUntil,
      handlerOptions.cloudflare,
      handlerOptions.runtime,
      handlerOptions.capabilities,
      routeAgentIdentity(handlerOptions),
    )
    return await runWithRuntimeCloudflareEnv(context, async () => {
      const match = await findAgentWebhookRegistration(agent, context, request, webhookId)
      if (!match) {
        return createJsonErrorResponse(404, "Unknown ViteHub agent webhook.")
      }

      const { registration, trigger } = match
      if (await matchedWebhookRegistrationRequiresVerification(registration, context, trigger.id !== "chat.message")) {
        try {
          await verifyAgentWebhookRequest([registration], request, context, { requireSecretHeader: true })
        }
        catch (error) {
          const response = toHttpErrorResponse(error)
          if (response) return response
          throw error
        }
      }

      if (trigger.id !== "chat.message") {
        try {
          const input = await createAgentWebhookTriggerInput(request, registration)
          const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, trigger.id, input)
          if (isResolvedAgentTriggerHandledInvocation(invocation)) {
            await context.flushWaitUntil?.()
            return invocation.response
          }
          if (invocation.webhook?.concurrencyKey !== undefined && await hasActiveWorkflowRuntime(agent, context)) {
            return createJsonErrorResponse(503, "Webhook concurrency ownership requires inline Agent execution.")
          }
          const webhookState = invocation.webhook
            ? await resolveAgentWebhookState(context, registration, handlerOptions)
            : undefined
          if (invocation.webhook && !webhookState) {
            return createJsonErrorResponse(503, "Durable Agent state is required for webhook delivery ownership.")
          }
          let webhookLock: Lock | null = null
          let deliveryClaimKey: string | undefined
          let concurrencyTtlMs = defaultWebhookConcurrencyTtlMs
          if (invocation.webhook && webhookState) {
            const { concurrencyKey, deliveryId } = invocation.webhook
            if (!deliveryId.trim()) {
              return createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty deliveryId.")
            }
            if (concurrencyKey !== undefined && !concurrencyKey.trim()) {
              return createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty concurrencyKey when configured.")
            }
            concurrencyTtlMs = positiveWebhookDuration(invocation.webhook.concurrencyTtlMs, defaultWebhookConcurrencyTtlMs, "concurrencyTtlMs")
            deliveryClaimKey = webhookOwnershipKey(webhookState.keyPrefix, "delivery", deliveryId)
            if (await webhookState.state.get(deliveryClaimKey) === true) {
              return Response.json({ accepted: false, duplicate: true, ok: true })
            }
            if (concurrencyKey !== undefined) {
              webhookLock = await webhookState.state.acquireLock(
                webhookOwnershipKey(webhookState.keyPrefix, "lease", concurrencyKey),
                concurrencyTtlMs,
              )
              if (!webhookLock) {
                return Response.json({ accepted: false, busy: true, ok: true }, { status: 503 })
              }
            }
            let claimed: boolean
            try {
              claimed = await webhookState.state.setIfNotExists(
                deliveryClaimKey,
                true,
              )
            }
            catch (error) {
              if (webhookLock) await webhookState.state.releaseLock(webhookLock)
              throw error
            }
            if (!claimed) {
              if (webhookLock) await webhookState.state.releaseLock(webhookLock)
              return Response.json({ accepted: false, duplicate: true, ok: true })
            }
          }
          const runContext = createRuntimeContext(
            request,
            invocation.run,
            waitUntil,
            handlerOptions.cloudflare,
            handlerOptions.runtime,
            handlerOptions.capabilities,
            routeAgentIdentity(handlerOptions),
          )
          const ownershipAbort = webhookLock ? new AbortController() : undefined
          let stopHeartbeat: (() => void) | undefined
          if (webhookLock && webhookState && ownershipAbort) {
            stopHeartbeat = startWebhookLockHeartbeat(webhookState.state, webhookLock, concurrencyTtlMs, () => {
              ownershipAbort.abort(new Error("[vitehub] Webhook concurrency ownership was lost during Agent execution."))
            })
          }
          let dispatch!: (accepted: boolean) => void
          const dispatchGate = new Promise<boolean>(resolve => {
            dispatch = resolve
          })
          const task = dispatchGate.then(async (accepted) => {
            if (!accepted) return
            await runWithRuntimeCloudflareEnv(runContext, async () => {
              try {
                const result = await runAgent(agent as never, runContext as never, {
                  ...invocation.input,
                  ...(ownershipAbort
                    ? {
                        abortSignal: invocation.input.abortSignal
                          ? AbortSignal.any([invocation.input.abortSignal, ownershipAbort.signal])
                          : ownershipAbort.signal,
                      }
                    : {}),
                } as never)
                if (!isWorkflowRun(result) || result.status !== "queued") {
                  await runContext.flushWaitUntil?.()
                }
              }
              finally {
                stopHeartbeat?.()
                if (webhookLock && webhookState) {
                  await webhookState.state.releaseLock(webhookLock)
                }
              }
            })
          })
          try {
            context.waitUntil(task)
            dispatch(true)
          }
          catch (error) {
            dispatch(false)
            stopHeartbeat?.()
            if (webhookLock && webhookState) await webhookState.state.releaseLock(webhookLock)
            if (deliveryClaimKey && webhookState) await webhookState.state.delete(deliveryClaimKey)
            throw error
          }
          return Response.json({ accepted: true, ok: true })
        }
        catch (error) {
          const response = toHttpErrorResponse(error)
          if (response) return response
          throw error
        }
      }

      const baseChatOptions = getAgentChatOptions(agent)
      const adapters = await resolveChatAdapters(baseChatOptions, context)
      const adapterName = resolveChatAdapterName(adapters, registration)
      const adapter = adapterName ? adapters[adapterName] : undefined
      if (!adapter) {
        return createJsonErrorResponse(500, `Agent chat webhook "${webhookId}" does not have a matching chat adapter.`)
      }

      try {
        const chatOptions = getChannelChatOptions(agent, registration.channelId, baseChatOptions)
        const handler = await createChatWebhookHandler(agent, context, registration, adapterName!, adapter, chatOptions, handlerOptions)
        const response = await handler(request, { waitUntil: context.waitUntil })
        if (chatOptions?.stream === false && hasExplicitNonStreamingMessages(agent, registration.channelId)) {
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

export function createDiscordGatewayRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, options: AgentDiscordGatewayRouteOptions) => Promise<Response> {
  return async (request, handlerOptions) => {
    if (request.method !== "GET") {
      return createJsonErrorResponse(405, "Discord Gateway route only accepts GET requests.")
    }

    const context = createRuntimeContext(
      request,
      undefined,
      await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
      handlerOptions.cloudflare,
      handlerOptions.runtime,
      handlerOptions.capabilities,
      routeAgentIdentity(handlerOptions),
    )
    return await runWithRuntimeCloudflareEnv(context, async () => {
      const chatOptions = getAgentChatOptions(agent)
      const adapters = await resolveChatAdapters(chatOptions, context)
      const entries = resolveDiscordAdapters(adapters)
      if (entries.length === 0) {
        return createJsonErrorResponse(500, "Discord Gateway route requires a Discord chat adapter.")
      }

      const responsePromises: Array<Promise<Response>> = []
      for (const [adapterName, adapter] of entries) {
        const startGatewayListener = (adapter as {
          startGatewayListener?: (
            options: { waitUntil?: (promise: Promise<unknown>) => void },
            durationMs?: number,
            abortSignal?: AbortSignal,
            webhookUrl?: string,
          ) => Promise<Response>
        }).startGatewayListener
        if (typeof startGatewayListener !== "function") {
          return createJsonErrorResponse(500, `Discord chat adapter "${adapterName}" does not expose startGatewayListener().`)
        }

        const { state } = await resolveChatState(chatOptions, context, {
          adapter: adapterName,
          channelId: adapterName,
          id: adapterName,
          provider: "discord",
        }, handlerOptions)
        const chat = new Chat(createChatSdkConfig(adapterName, adapter, state, chatOptions))
        await (chat as { initialize?: () => Promise<void> }).initialize?.()
        const registration = await resolveDiscordWebhookRegistration(agent, context, adapters, adapterName)
        const webhookId = registration?.id || adapterName
        const webhookUrl = typeof handlerOptions.webhookUrl === "function"
          ? handlerOptions.webhookUrl(webhookId)
          : handlerOptions.webhookUrl

        responsePromises.push(startGatewayListener.call(
          adapter,
          { waitUntil: context.waitUntil },
          handlerOptions.durationMs,
          undefined,
          webhookUrl,
        ))
      }

      const responses = await Promise.all(responsePromises)
      if (responses.length === 1) return responses[0]!
      const failed = responses.find(response => !response.ok)
      if (failed) return failed
      return Response.json({ gateways: responses.length, ok: true })
    })
  }
}
