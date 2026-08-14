import { parseStandardSchema } from "@vite-hub/internal/http-request"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeWaitUntilController, resolveRuntimeContext } from "@vite-hub/runtime"
import { Chat, StreamingPlan, ThreadImpl, convertEmojiPlaceholders } from "chat"

import { resolveAgentTriggerInvocation, resolveAgentTriggers, runAgent, runAgentInline, startAgentInvocation, streamAgent, streamAgentTrigger } from "../index.ts"
import { awaitAgentInvocationResult } from "../agent-invocation.ts"
import { hasTraceableStreamResult, isAsyncIterable, streamAgentOutputToEvents } from "../agent-output.ts"
import { toAgentPublicError } from "../agent-error.ts"
import { getAccessCapabilityOptions } from "../capabilities/access-metadata.ts"
import { assertChatDeliveryOptions, CHAT_FINISH_EXTENSION_CONTEXT_KEY, getChatCapabilityOptions } from "../chat-trigger.ts"
import { chatTriggerHistoryLimit, createChatMessageTriggerInput, resolveChatSessionBaseId, resolveChatSessionId, resolveChatTriggerHistory, uiMessagesToAgentMessages } from "../chat-message-input.ts"
import { normalizeCapabilities } from "../capability-runtime.ts"
import { deliveryArtifactAttachments } from "../delivery-artifacts.ts"
import { createAgentInvocationContextStore } from "../invocation-context.ts"
import { finalChannelOutputContextKey, hasOnlyPortableAgentWorkflowCapabilities, requireAgentWorkflowContextKey } from "../internal/final-channel-output.ts"
import { agentChannelSyncProviderHeader } from "../internal/channel-sync.ts"
import { agentOutputEventObserverContextKey } from "../internal/agent-output-events.ts"
import { isAttachmentData } from "../messages.ts"
import { resolveAgentInvoker, withResolvedAgentInvokerInput } from "../invoker.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { createAgentUIMessageStreamResponse, uiMessageStreamFromResponse } from "../stream-output.ts"
import { isResolvedAgentTriggerHandledInvocation, resolveAgentTriggerInvocation as resolveAgentTriggerInvocationWithResolvedContext, resolveAgentTriggerInvocationResult, verifyAgentWebhookRequest } from "../trigger-runtime.ts"
import { AgentHttpError, toHttpErrorResponse } from "../http-error.ts"
import { isWorkflowRun } from "../http-response.ts"
import { messageChannelStateContextKey } from "../internal/channels.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"
import { hasAgentWebhookQueue } from "../internal/webhook-queue.ts"
import { activeAgentInvocation, registerActiveAgentInvocation } from "../internal/agent-invocation-control.ts"

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
  AgentMessageDeliveryKind,
  AgentRunInput,
  AgentRunMetadata,
  AgentToolStepItem,
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
import type { AgentWebhookQueueDelivery, AgentWebhookQueueLease, AgentWebhookQueueStateAdapter } from "../internal/webhook-queue.ts"

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

export interface AgentChannelWebhookRouteHandler {
  (request: Request, webhook?: string, options?: AgentChannelWebhookRouteOptions): Promise<Response>
  resume(options?: AgentChannelWebhookRouteOptions): () => Promise<void>
}

export interface AgentDiscordGatewayRouteOptions extends AgentRouteRuntimeOptions {
  abortSignal?: AbortSignal
  agentName?: string
  durationMs?: number
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
  webhookUrl?: string | ((adapterName: string) => string)
}

export interface AgentTelegramPollingRouteOptions extends AgentRouteRuntimeOptions {
  agentName?: string
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
}

export interface AgentChannelChatRouteRequestOptions extends AgentRouteRuntimeOptions {
  agentName?: string
  state?: AgentChatStateResolver<ViteAgentRouteRuntimeConfig>
  event?: unknown
}

export interface AgentChannelChatRouteInspection {
  activeRuns: number
  bufferedBytes: number
  liveSubscribers: number
  maxBufferedBytesPerOwner: number
  maxPendingCancellationsPerOwner: number
  maxPendingClaimsPerOwner: number
  maxPendingLookupsPerOwner: number
  maxTotalBufferedBytes: number
  maxTotalPendingCancellations: number
  maxTotalPendingClaims: number
  maxTotalPendingLookups: number
  maxTotalPendingOwnerResolutions: number
  maxRunsPerOwner: number
  maxSubscribersPerRun: number
  maxTotalRuns: number
  pendingCancellations: number
  pendingClaims: number
  pendingLookups: number
  pendingOwnerResolutions: number
  retainedRuns: number
}

export interface AgentChannelChatRouteHandler {
  (request: Request, options?: AgentChannelChatRouteRequestOptions): Promise<Response>
  inspect(): AgentChannelChatRouteInspection
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
  event?: unknown
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

export interface AgentChannelChatRouteResumableContext<TAuth = unknown>
  extends AgentChannelChatRouteAdmissionContext {
  auth: Exclude<TAuth, false>
}

export interface AgentChannelChatRouteResumableOptions<TAuth = unknown> {
  owner: (context: AgentChannelChatRouteResumableContext<TAuth>) => MaybePromise<string>
  /** Streams stay in one handler process; use shared run storage when restarts or replicas must resume. */
}

export interface AgentChannelChatRouteHandlerOptions<TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody, TAuth = unknown> {
  admission?: AgentChannelChatRouteAdmissionOptions<TBody, TAuth>
  channelId?: string
  input?: AgentChannelChatRouteInputOptions
  mapInput?: (context: AgentChannelChatRouteMapInputContext<TBody, TAuth>) => MaybePromise<AgentChannelChatRouteInputPatch | undefined | void>
  origin?: string
  resumable?: AgentChannelChatRouteResumableOptions<TAuth>
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

function isReadableStreamLike(value: unknown): value is ReadableStream<unknown> {
  return isRecord(value)
    && typeof value.getReader === "function"
    && typeof value.pipeThrough === "function"
}

function isHeadersLike(value: unknown): value is Headers {
  return isRecord(value)
    && typeof value.entries === "function"
    && typeof value.get === "function"
}

function isResponseLike(value: unknown): value is Response & { body: ReadableStream<unknown> } {
  return isRecord(value)
    && isReadableStreamLike(value.body)
    && isHeadersLike(value.headers)
    && typeof value.status === "number"
    && typeof value.statusText === "string"
}

function readableStreamFromResult(value: unknown): ReadableStream<unknown> {
  if (value instanceof ReadableStream || isReadableStreamLike(value)) return value
  if (value instanceof Response && value.body) return value.body
  if (isResponseLike(value)) return value.body
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
  const headers = new Headers([...response.headers.entries()])
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

interface ErrorLogSerializationState {
  nodes: number
  remainingStringCharacters: number
  seen: WeakSet<object>
}

const errorLogMaxDepth = 5
const errorLogMaxNodes = 100
const errorLogMaxProperties = 20
const errorLogMaxStringLength = 2_048
const errorLogStringBudget = 12_000

function serializeLogString(value: string, state: ErrorLogSerializationState): string {
  if (value.startsWith("data:")) return `[Data URL ${value.length} characters]`
  if (state.remainingStringCharacters <= 0) return "[Truncated]"
  const available = Math.min(errorLogMaxStringLength, state.remainingStringCharacters)
  if (value.length <= available) {
    state.remainingStringCharacters -= value.length
    return value
  }
  const suffix = `… [${value.length - available} chars omitted]`
  const result = available > suffix.length
    ? `${value.slice(0, available - suffix.length)}${suffix}`
    : "[Truncated]"
  state.remainingStringCharacters -= result.length
  return result
}

function serializeErrorForLog(
  value: unknown,
  state: ErrorLogSerializationState = {
    nodes: 0,
    remainingStringCharacters: errorLogStringBudget,
    seen: new WeakSet<object>(),
  },
  depth = 0,
): unknown {
  if (typeof value === "string") return serializeLogString(value, state)
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "undefined") return value
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return serializeLogString(String(value), state)
  }
  if (typeof value !== "object") return serializeLogString(String(value), state)
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (value instanceof Blob) return `[Blob ${value.size} bytes, ${value.type || "unknown type"}]`
  if (value instanceof Date) return value.toISOString()
  if (state.seen.has(value)) return "[Circular]"
  if (depth >= errorLogMaxDepth || state.nodes >= errorLogMaxNodes) return "[Truncated]"
  state.seen.add(value)
  state.nodes++

  if (Array.isArray(value)) {
    const output = value.slice(0, errorLogMaxProperties)
      .map(item => serializeErrorForLog(item, state, depth + 1))
    if (value.length > output.length) output.push(`[${value.length - output.length} items omitted]`)
    return output
  }

  const output: Record<string, unknown> = {}
  const source = value as Record<string, unknown>
  if (value instanceof Error) {
    output.message = serializeErrorForLog(value.message, state, depth + 1)
    output.name = serializeErrorForLog(value.name, state, depth + 1)
    if (value.stack) output.stack = serializeErrorForLog(value.stack, state, depth + 1)
  }
  const keys = Object.keys(value)
    .filter(key => !(value instanceof Error && (key === "message" || key === "name" || key === "stack" || key === "cause")))
    .slice(0, errorLogMaxProperties)
  for (const key of keys) {
    const outputKey = key.length > 128 ? `${key.slice(0, 112)}… [key truncated]` : key
    try {
      output[outputKey] = serializeErrorForLog(source[key], state, depth + 1)
    }
    catch {
      output[outputKey] = "[Unserializable property]"
    }
  }
  if (Object.keys(value).length > keys.length) {
    output["[truncated]"] = `${Object.keys(value).length - keys.length} properties omitted`
  }
  if (value instanceof Error && "cause" in value && typeof value.cause !== "undefined") {
    output.cause = serializeErrorForLog(value.cause, state, depth + 1)
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

function createRuntimeRequest(request: Request, body?: string, signal = request.signal): Request {
  return new Request(request.url, {
    ...(body ? { body } : {}),
    headers: request.headers,
    method: request.method,
    signal,
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
  const registrations = await agentWebhookRegistrations(agent, context)
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

async function agentWebhookRegistrations(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
): Promise<AgentWebhookRegistrationMatch[]> {
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  return Object.values(triggers).flatMap(trigger => (trigger.webhooks || []).map(registration => ({
    registration,
    trigger: trigger as ResolvedAgentTriggerDefinition<ViteAgentRouteRuntimeConfig>,
  })))
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
function webhookScopeComponent(value: string): string {
  return encodeURIComponent(value)
}

const webhookStateBackendIds = new WeakMap<StateAdapter, Promise<string>>()

function resolveWebhookStateBackendId(state: StateAdapter): Promise<string> {
  const existing = webhookStateBackendIds.get(state)
  if (existing) return existing
  const resolving = (async () => {
    const backendIdKey = "webhook:backend-id"
    const stored = await state.get(backendIdKey)
    if (typeof stored === "string" && stored) return stored
    await state.setIfNotExists(backendIdKey, globalThis.crypto.randomUUID())
    const backendId = await state.get(backendIdKey)
    if (typeof backendId !== "string" || !backendId) {
      throw new Error("[vitehub] Webhook Agent state returned an invalid backend identity.")
    }
    return backendId
  })()
  webhookStateBackendIds.set(state, resolving)
  void resolving.catch(() => webhookStateBackendIds.delete(state))
  return resolving
}

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
  const keyPrefix = `webhook:${webhookScopeComponent(agentName)}:${webhookScopeComponent(origin)}:${webhookScopeComponent(registrationId)}:`
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

function webhookOwnershipKey(prefix: string, kind: "delivery" | "lease" | "steer" | "steer-lock" | "steer-send-lock", value: string): string {
  return `${prefix}${kind}:${value}`
}

const defaultWebhookQueueRetryMs = 1_000

function positiveWebhookConcurrencyLimit(value: number | undefined): number | undefined {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("[vitehub] Webhook delivery ownership concurrencyLimit must be a positive integer.")
  }
  return value
}

function persistedWebhookRequest(
  deliveryId: string,
  request: Request,
  body: string,
  webhookId: string,
  ownership: { concurrencyGroup?: string, concurrencyKey?: string, concurrencyLimit: number, concurrencyTtlMs?: number },
  scope: string,
  agentName: string,
  invocation?: { input: unknown, run?: unknown },
  rehydrate?: boolean,
): AgentWebhookQueueDelivery {
  const enqueuedAt = Date.now()
  const concurrencyGroup = `${encodeURIComponent(agentName)}:${encodeURIComponent(ownership.concurrencyGroup?.trim() || "default")}`
  return {
    concurrencyGroup,
    ...(ownership.concurrencyKey ? { concurrencyKey: `${concurrencyGroup}:${encodeURIComponent(ownership.concurrencyKey)}` } : {}),
    concurrencyLimit: ownership.concurrencyLimit,
    deliveryId,
    enqueuedAt,
    ...(invocation ? { invocation } : {}),
    leaseTtlMs: positiveWebhookDuration(ownership.concurrencyTtlMs, defaultWebhookConcurrencyTtlMs, "concurrencyTtlMs"),
    ...(rehydrate ? { rehydrate: true as const } : {}),
    request: {
      body,
      headers: requestHeaders(request),
      method: request.method,
      url: request.url,
    },
    scope,
    webhookId,
  }
}

function isJsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  seen.add(value)
  const safe = Object.values(value).every(entry => isJsonSafe(entry, seen))
  seen.delete(value)
  return safe
}

function persistedWebhookInvocation(
  invocation: { input: Record<string, unknown>, run?: unknown },
): { input: Record<string, unknown>, run?: unknown } {
  const { abortSignal: _abortSignal, ...input } = invocation.input
  return {
    input,
    ...(invocation.run ? { run: invocation.run } : {}),
  }
}

function requestFromPersistedWebhook(delivery: AgentWebhookQueueDelivery): Request {
  return new Request(delivery.request.url, {
    body: delivery.request.body || undefined,
    headers: delivery.request.headers,
    method: delivery.request.method,
  })
}

async function steerQueuedWebhookDelivery(
  state: AgentWebhookQueueStateAdapter,
  activeInvocationScope: object,
  backendId: string,
  delivery: AgentWebhookQueueDelivery,
  input: AgentRunInput,
  waitUntil: AgentWaitUntil | undefined,
  fallback: (reserved?: boolean) => Promise<Response>,
): Promise<{ queued: boolean, response: Response } | undefined> {
  if (!delivery.concurrencyKey) return
  const claimKey = webhookOwnershipKey(delivery.scope, "steer", delivery.deliveryId)
  const duplicateResponse = (claim: unknown) => claim === "queued"
    ? { queued: true, response: Response.json({ accepted: false, duplicate: true, ok: true, queued: false }) }
    : {
        queued: claim === "steering",
        response: Response.json({ accepted: false, duplicate: true, ok: true, steered: true }),
      }
  const existingClaim = await state.get(claimKey)
  if (existingClaim) {
    return duplicateResponse(existingClaim)
  }
  const lock = await state.acquireLock(
    webhookOwnershipKey(delivery.scope, "steer-lock", delivery.deliveryId),
    delivery.leaseTtlMs,
  )
  if (!lock) {
    const claimed = await state.get(claimKey)
    if (claimed) {
      return duplicateResponse(claimed)
    }
    return { queued: false, response: Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }) }
  }
  const stopHeartbeat = startWebhookLockHeartbeat(state, lock, delivery.leaseTtlMs, () => undefined)
  let keepLockUntilInvocationSettles = false
  try {
    const claimed = await state.get(claimKey)
    if (claimed) {
      return duplicateResponse(claimed)
    }
    const active = activeAgentInvocation(`${backendId}:${delivery.concurrencyKey}`, activeInvocationScope)
    if (active) {
      const { controller } = active
      const sendLock = await state.acquireLock(
        webhookOwnershipKey(`webhook-backend:${webhookScopeComponent(backendId)}:`, "steer-send-lock", delivery.concurrencyKey),
        delivery.leaseTtlMs,
      )
      if (!sendLock) {
        return { queued: false, response: Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }) }
      }
      let sendLockLost = false
      const stopSendHeartbeat = startWebhookLockHeartbeat(state, sendLock, delivery.leaseTtlMs, () => {
        sendLockLost = true
        void controller.cancel(new Error("[vitehub] Webhook steering lost its serialized input lease.")).catch(() => {})
      })
      try {
        const steeringLease: AgentWebhookQueueLease = {
          ...delivery,
          attempts: 0,
          leaseExpiresAt: Date.now() + delivery.leaseTtlMs,
          leaseToken: lock.token,
        }
        if (!await state.claimWebhookSteering(delivery, steeringLease.leaseToken, steeringLease.leaseExpiresAt)) {
          const response = await fallback(false)
          await state.set(claimKey, "queued")
          return { queued: true, response }
        }
        try {
          await state.set(claimKey, "steering")
        }
        catch {
          await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now())
          await state.delete(claimKey).catch(() => undefined)
          return { queued: true, response: await fallback(true) }
        }
        let steeringLeaseLost = false
        const stopDeliveryHeartbeat = startWebhookQueueHeartbeat(state, steeringLease, () => {
          steeringLeaseLost = true
          void controller.cancel(new Error("[vitehub] Webhook steering lost its durable delivery lease.")).catch(() => {})
        })
        let accepted = false
        try {
          const result = await controller.sendInput(input, { mode: "steer" })
          accepted = result.outcome === "accepted"
        }
        catch {}
        if (steeringLeaseLost || sendLockLost) {
          stopDeliveryHeartbeat()
          await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now())
          await state.delete(claimKey)
          return { queued: false, response: Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }) }
        }
        if (accepted) {
          keepLockUntilInvocationSettles = true
          const settlement = active.result
            .then(async () => {
              const completed = await state.completeWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken)
              if (completed) await state.set(claimKey, "steered")
              else await state.delete(claimKey)
            })
            .catch(async () => {
              await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now())
              await state.delete(claimKey)
            })
            .finally(async () => {
              stopDeliveryHeartbeat()
              stopHeartbeat()
              await state.releaseLock(lock)
            })
            .catch(() => {})
          waitUntil?.(settlement)
          return { queued: false, response: Response.json({ accepted: true, ok: true, steered: true }) }
        }
        stopDeliveryHeartbeat()
        await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now())
        await state.set(claimKey, "queued")
        return { queued: true, response: await fallback(true) }
      }
      finally {
        stopSendHeartbeat()
        await state.releaseLock(sendLock)
      }
    }
    const response = await fallback(false)
    await state.set(claimKey, "queued")
    return { queued: true, response }
  }
  finally {
    if (!keepLockUntilInvocationSettles) {
      stopHeartbeat()
      await state.releaseLock(lock)
    }
  }
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
  requireAvailable = false,
): Promise<boolean> {
  if (!isRecord(agent) || !isRecord(agent.runtime) || agent.runtime.kind !== "workflow") return false
  if (!await hasOnlyPortableAgentWorkflowCapabilities(context.capabilities)) return false
  if (agent.runtime.discoveryDefault !== true && !requireAvailable) return true
  if (agent.runtime.discoveryDefault === true && !context.agentIdentity) return false
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
  const retryMs = Math.max(1, Math.min(250, Math.floor(ttlMs / 4)))
  let knownLeaseExpiresAt = lock.expiresAt
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const extend = async () => {
    if (stopped) return
    const extensionStartedAt = Date.now()
    try {
      const extended = await state.extendLock(lock, ttlMs)
      if (stopped) return
      if (!extended) {
        stopped = true
        onLost()
        return
      }
      knownLeaseExpiresAt = extensionStartedAt + ttlMs
    }
    catch {
      if (stopped) return
      const remainingMs = knownLeaseExpiresAt - Date.now()
      if (remainingMs <= 0) {
        stopped = true
        onLost()
        return
      }
      timer = setTimeout(extend, Math.min(retryMs, remainingMs))
      return
    }
    if (!stopped) timer = setTimeout(extend, Math.max(1, knownLeaseExpiresAt - Date.now() - intervalMs))
  }
  timer = setTimeout(extend, intervalMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

function startWebhookQueueHeartbeat(
  state: AgentWebhookQueueStateAdapter,
  delivery: AgentWebhookQueueLease,
  onLost: () => void,
): () => void {
  const intervalMs = Math.max(1, Math.floor(delivery.leaseTtlMs / 2))
  const retryMs = Math.max(1, Math.min(250, Math.floor(delivery.leaseTtlMs / 4)))
  let knownLeaseExpiresAt = delivery.leaseExpiresAt
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const extend = async () => {
    if (stopped) return
    const extensionStartedAt = Date.now()
    try {
      const extended = await state.extendWebhookDeliveryLease(
        delivery.scope,
        delivery.deliveryId,
        delivery.leaseToken,
        delivery.leaseTtlMs,
      )
      if (stopped) return
      if (!extended) {
        stopped = true
        onLost()
        return
      }
      knownLeaseExpiresAt = extensionStartedAt + delivery.leaseTtlMs
    }
    catch {
      if (stopped) return
      const remainingMs = knownLeaseExpiresAt - Date.now()
      if (remainingMs <= 0) {
        stopped = true
        onLost()
        return
      }
      timer = setTimeout(extend, Math.min(retryMs, remainingMs))
      return
    }
    if (!stopped) timer = setTimeout(extend, Math.max(1, knownLeaseExpiresAt - Date.now() - intervalMs))
  }
  timer = setTimeout(extend, intervalMs)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

async function executeQueuedWebhookDelivery(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  state: AgentWebhookQueueStateAdapter,
  activeInvocationScope: object,
  backendId: string,
  delivery: AgentWebhookQueueLease,
  handlerOptions: AgentChannelWebhookRouteOptions,
  lifecycleSignal: AbortSignal,
): Promise<number | undefined> {
  let resolveActiveCompletion: (() => void) | undefined
  let rejectActiveCompletion: ((reason?: unknown) => void) | undefined
  const request = requestFromPersistedWebhook(delivery)
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
  const ownershipAbort = new AbortController()
  const stopHeartbeat = startWebhookQueueHeartbeat(state, delivery, () => {
    ownershipAbort.abort(new Error("[vitehub] Webhook queue lease was lost during Agent execution."))
  })
  const stopForLifecycle = () => {
    stopHeartbeat()
    ownershipAbort.abort(lifecycleSignal.reason)
  }
  if (lifecycleSignal.aborted) stopForLifecycle()
  else lifecycleSignal.addEventListener("abort", stopForLifecycle, { once: true })
  try {
    if (await hasActiveWorkflowRuntime(agent, context)) {
      throw new Error("[vitehub] Persisted webhook concurrency requires inline Agent execution.")
    }
    type PersistedInvocation = {
      input: Record<string, unknown> & { abortSignal?: AbortSignal }
      run?: Parameters<typeof createRuntimeContext>[1]
    }
    let invocation = delivery.invocation as PersistedInvocation | undefined
    if (!invocation) {
      const resolved = await runWithRuntimeCloudflareEnv(context, async () => {
        const match = await findAgentWebhookRegistration(agent, context, request, delivery.webhookId)
        if (!match) throw new Error(`[vitehub] Persisted webhook registration "${delivery.webhookId}" no longer exists.`)
        const input = await createAgentWebhookTriggerInput(request, match.registration)
        const replayed = await resolveAgentTriggerInvocationWithResolvedContext(agent as never, resolveRuntimeContext(context as never) as never, match.trigger.id, input, { verifyWebhook: false })
        if (delivery.rehydrate && isResolvedAgentTriggerHandledInvocation(replayed)) {
          throw new Error("[vitehub] Persisted webhook delivery requires rehydration, but its trigger handled the replayed request.")
        }
        if (!isResolvedAgentTriggerHandledInvocation(replayed) && delivery.rehydrate && !replayed.webhook?.rehydrate) {
          throw new Error("[vitehub] Persisted webhook delivery requires rehydration, but its trigger no longer provides a rehydrate callback.")
        }
        const resolved = !isResolvedAgentTriggerHandledInvocation(replayed) && delivery.rehydrate && replayed.webhook?.rehydrate
          ? resolveAgentTriggerInvocationResult(await replayed.webhook.rehydrate(), replayed.trigger)
          : replayed
        await context.flushWaitUntil?.()
        return resolved
      })
      if (!isResolvedAgentTriggerHandledInvocation(resolved)) {
        if (!resolved.webhook || resolved.webhook.deliveryId !== delivery.deliveryId) {
          throw new Error("[vitehub] Persisted webhook delivery no longer resolves to the same deliveryId.")
        }
        invocation = resolved as unknown as PersistedInvocation
      }
    }
    if (invocation) {
      const runContext = createRuntimeContext(
        request,
        invocation.run,
        waitUntil,
        handlerOptions.cloudflare,
        handlerOptions.runtime,
        handlerOptions.capabilities,
        routeAgentIdentity(handlerOptions),
      )
      await runWithRuntimeCloudflareEnv(runContext, async () => {
        const controller = await startAgentInvocation(agent as never, runContext as never, {
          ...invocation.input,
          abortSignal: invocation.input.abortSignal
            ? AbortSignal.any([invocation.input.abortSignal, ownershipAbort.signal])
            : ownershipAbort.signal,
        } as never, { runId: invocation.run?.runId })
        const result = awaitAgentInvocationResult(controller)
        const settlement = result.then(async (output) => {
          if (!isWorkflowRun(output) || output.status !== "queued") await runContext.flushWaitUntil?.()
          return output
        })
        const activeCompletion = new Promise<void>((resolve, reject) => {
          resolveActiveCompletion = resolve
          rejectActiveCompletion = reject
        })
        void activeCompletion.catch(() => undefined)
        const unregister = delivery.concurrencyKey
          ? registerActiveAgentInvocation(`${backendId}:${delivery.concurrencyKey}`, controller, activeCompletion, activeInvocationScope)
          : () => undefined
        const unregisterOnOwnershipLoss = () => unregister()
        if (ownershipAbort.signal.aborted) unregisterOnOwnershipLoss()
        else ownershipAbort.signal.addEventListener("abort", unregisterOnOwnershipLoss, { once: true })
        try {
          await settlement
        }
        finally {
          ownershipAbort.signal.removeEventListener("abort", unregisterOnOwnershipLoss)
          unregister()
        }
      })
    }
    if (!await state.completeWebhookDelivery(delivery.scope, delivery.deliveryId, delivery.leaseToken)) {
      throw new Error("[vitehub] Webhook queue completion lost its lease.")
    }
    resolveActiveCompletion?.()
  }
  catch (error) {
    rejectActiveCompletion?.(error)
    const retryDelay = lifecycleSignal.aborted
      ? 0
      : Math.min(60_000, defaultWebhookQueueRetryMs * 2 ** Math.min(delivery.attempts, 6))
    const retryAt = Date.now() + retryDelay
    if (await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, delivery.leaseToken, retryAt)) {
      if (lifecycleSignal.aborted) return retryAt
      console.error(`[vitehub] Queued webhook delivery "${delivery.deliveryId}" failed and will be retried.`, error)
      return retryAt
    }
  }
  finally {
    lifecycleSignal.removeEventListener("abort", stopForLifecycle)
    stopHeartbeat()
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

async function collectAgentOutput(
  result: unknown,
  onProgress?: (summary: string) => void,
  onToolResult?: (result: AgentToolStepItem) => void,
): Promise<string> {
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
    const summary = progressSummaryFromEvent(event)
    if (summary) onProgress?.(summary)
    if (event.type === "tool-result" && !event.error) {
      onToolResult?.({
        output: event.output,
        toolCallId: event.id,
        toolName: event.name,
      })
    }
    if (event.type === "error") {
      throw new Error(event.error)
    }
  }
  return (explicitPhaseSeen ? finalText : unphasedText).trim()
}

const manualDeliveryProgressDrainTimeoutMs = 100

function progressSummaryFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== "data-progress-summary") return
  const summary = isRecord(event.data) && typeof event.data.summary === "string"
    ? event.data.summary.trim()
    : ""
  return summary || undefined
}

function createManualDeliveryProgressUpdater(
  manualDelivery: { placeholder?: unknown },
  waitUntil: AgentWaitUntil,
  abortSignal?: AbortSignal,
): {
  finish: () => Promise<void>
  update: (summary: string) => void
} {
  let latest: string | undefined
  let active = true
  let draining: Promise<void> | undefined

  const drain = async () => {
    while (active && latest && manualDelivery.placeholder) {
      const summary = latest
      latest = undefined
      await replaceManualDeliveryPlaceholder(manualDelivery.placeholder, { markdown: summary }).catch(() => false)
    }
  }
  const startDrain = () => {
    if (draining) return
    draining = drain().finally(() => {
      draining = undefined
      if (active && latest && manualDelivery.placeholder) startDrain()
    })
  }

  return {
    async finish() {
      active = false
      if (!draining) return

      let timeout: ReturnType<typeof setTimeout> | undefined
      const drained = await Promise.race([
        draining.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), manualDeliveryProgressDrainTimeoutMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      if (drained || !manualDelivery.placeholder) return

      const stalePlaceholder = manualDelivery.placeholder
      manualDelivery.placeholder = undefined
      if (abortSignal?.aborted) {
        waitUntil(deleteManualDeliveryPlaceholder(stalePlaceholder).catch(() => undefined))
        return
      }
      const cleanup = draining.then(async () => {
        await deleteManualDeliveryPlaceholder(stalePlaceholder).catch(() => undefined)
      })
      waitUntil(cleanup)
    },
    update(summary) {
      if (!manualDelivery.placeholder) return
      latest = summary
      startDrain()
    },
  }
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
  let cancelTypingWait: (() => void) | undefined

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
        new Promise<void>(resolve => {
          cancelTypingWait = resolve
          limit = setTimeout(resolve, chatTypingRefreshTimeoutMs)
        }),
      ])
    }
    finally {
      cancelTypingWait = undefined
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
      cancelTypingWait?.()
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
  onToolResult?: (result: AgentToolStepItem) => void,
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
        if (event.type === "tool-result" && !event.error) {
          onToolResult?.({
            output: event.output,
            toolCallId: event.id,
            toolName: event.name,
          })
        }
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
    onToolResult?: (result: AgentToolStepItem) => void
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
        if (event.type === "tool-result" && !event.error) {
          options.onToolResult?.({
            output: event.output,
            toolCallId: event.id,
            toolName: event.name,
          })
        }
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

async function postDiscordSplitContent(
  thread: Thread,
  postable: AdapterPostableMessage,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (discordLongContentMode(thread.adapter) !== "split") return false
  const rendered = renderDiscordPostable(thread.adapter, postable)
  if (!rendered || rendered.length <= discordMaxContentLength) return false
  const sentMessages: unknown[] = []
  for (const part of discordContentParts(rendered)) {
    const sent = await thread.post({ raw: part })
    sentMessages.push(sent)
    if (abortSignal?.aborted) {
      await Promise.allSettled(sentMessages.map(deleteManualDeliveryPlaceholder))
      abortSignal.throwIfAborted()
    }
  }
  return true
}

async function finishDiscordSplitStream(
  thread: Thread,
  sent: unknown,
  markdown: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!markdown || discordLongContentMode(thread.adapter) !== "split") return
  const rendered = renderDiscordPostable(thread.adapter, { markdown })
  if (!rendered || rendered.length <= discordMaxContentLength) return
  const [first, ...rest] = discordContentParts(rendered)
  const sentMessages = sent ? [sent] : []
  if (first && sent && typeof sent === "object" && "edit" in sent && typeof sent.edit === "function") {
    await sent.edit({ attachments: [], raw: first })
  }
  else if (first) {
    sentMessages.push(await thread.post({ raw: first }))
  }
  if (abortSignal?.aborted) {
    await Promise.allSettled(sentMessages.map(deleteManualDeliveryPlaceholder))
    abortSignal.throwIfAborted()
  }
  for (const part of rest) {
    abortSignal?.throwIfAborted()
    sentMessages.push(await thread.post({ raw: part }))
    if (abortSignal?.aborted) {
      await Promise.allSettled(sentMessages.map(deleteManualDeliveryPlaceholder))
      abortSignal.throwIfAborted()
    }
  }
}

function sentMessageText(sent: unknown): string {
  return sent && typeof sent === "object" && "text" in sent && typeof sent.text === "string" ? sent.text : ""
}

async function removeAbortedChatDelivery(sent: unknown, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal?.aborted) return
  await deleteManualDeliveryPlaceholder(sent)
  abortSignal.throwIfAborted()
}

async function settleChatCleanup(
  task: Promise<unknown>,
  maximumDeadline?: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  const abortableTask = abortSignal
    ? new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          abortSignal.removeEventListener("abort", onAbort)
          reject(abortSignal.reason)
        }
        abortSignal.addEventListener("abort", onAbort, { once: true })
        task.then(
          (value) => {
            abortSignal.removeEventListener("abort", onAbort)
            resolve(value)
          },
          (error) => {
            abortSignal.removeEventListener("abort", onAbort)
            reject(error)
          },
        )
        if (abortSignal.aborted) onAbort()
      })
    : task
  await enforceChatInvocationTimeout(
    abortableTask,
    maximumDeadline === undefined ? undefined : Math.max(0, maximumDeadline - Date.now()),
  ).catch(() => undefined)
}

async function postChatStream(
  thread: Thread,
  response: ChatTextStream,
  fallback: string | null | undefined,
  waitUntil: AgentWaitUntil,
  abortSignal?: AbortSignal,
  maximumDeadline?: number,
): Promise<void> {
  abortSignal?.throwIfAborted()
  let sent: unknown
  if (fallback === undefined) {
    sent = await thread.post(chatStreamPostable(thread, response) as never)
    await removeAbortedChatDelivery(sent, abortSignal)
    await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent), abortSignal)
    await removeAbortedChatDelivery(sent, abortSignal)
    return
  }

  if (thread.adapter.stream) {
    const adapter = thread.adapter
    const nativeStream = adapter.stream!.bind(adapter)
    const placeholder = fallback === null
      ? Promise.resolve(undefined)
      : adapter.postMessage(thread.id, fallback)
    let cleared = false
    let clearing: Promise<void> | undefined
    let clearRequested = false
    const clearPlaceholder = async () => {
      if (cleared) return
      if (clearing) return clearing
      clearing = settleChatCleanup(placeholder.then(async (message) => {
        if (!message?.id) return
        await adapter.deleteMessage(message.threadId || thread.id, message.id)
        cleared = true
      }), maximumDeadline, abortSignal).finally(() => {
        clearing = undefined
      })
      return clearing
    }
    const finishPlaceholder = () => {
      waitUntil(clearPlaceholder().then(() => cleared || abortSignal?.aborted ? undefined : clearPlaceholder()))
    }
    abortSignal?.addEventListener("abort", finishPlaceholder, { once: true })
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
      await removeAbortedChatDelivery(sent, abortSignal)
      await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent), abortSignal)
      await removeAbortedChatDelivery(sent, abortSignal)
    }
    finally {
      abortSignal?.removeEventListener("abort", finishPlaceholder)
      chatThread._adapter = previousAdapter
      chatThread._fallbackStreamingPlaceholderText = previousFallback
      finishPlaceholder()
    }
    return
  }

  // ponytail: Chat SDK has no per-stream fallback option; replace this when it exposes one.
  const adapter = thread.adapter
  const placeholder = fallback === null
    ? Promise.resolve(undefined)
    : adapter.postMessage(thread.id, fallback)
  const clearPlaceholder = () => {
    waitUntil(settleChatCleanup(placeholder.then(async (message) => {
      if (message?.id) await adapter.deleteMessage(message.threadId || thread.id, message.id)
    }), maximumDeadline, abortSignal))
  }
  abortSignal?.addEventListener("abort", clearPlaceholder, { once: true })
  const chatThread = thread as Thread & { _adapter?: Adapter, _fallbackStreamingPlaceholderText?: string | null }
  const previousAdapter = chatThread._adapter
  const previous = chatThread._fallbackStreamingPlaceholderText
  chatThread._adapter = new Proxy(adapter, {
    get(target, property) {
      if (property === "postMessage" && fallback !== null) {
        return async (...args: Parameters<Adapter["postMessage"]>) => {
          if (args[0] === thread.id && args[1] === fallback) {
            return await placeholder
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
    sent = await thread.post(chatStreamPostable(thread, response) as never)
    await removeAbortedChatDelivery(sent, abortSignal)
    await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent), abortSignal)
    await removeAbortedChatDelivery(sent, abortSignal)
  }
  finally {
    abortSignal?.removeEventListener("abort", clearPlaceholder)
    chatThread._adapter = previousAdapter
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
    disconnect: async () => {
      // Scoped views share their backing state with other Channels and process handlers.
    },
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

function stateResolverOwnsScope(state: unknown): boolean {
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
  if (options?.state === undefined && !stateResolverOwnsScope(handlerOptions.state)) {
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

interface ChatLockTracker {
  refresh(lockKey: string): () => void
  state: StateAdapter
}

function createChatLockTracker(state: StateAdapter): ChatLockTracker {
  const locks = new Map<string, { lock: Lock, ttlMs: number }>()
  const trackedState = new Proxy(state, {
    get(target, property) {
      if (property === "acquireLock") {
        return async (lockKey: string, ttlMs: number) => {
          const lock = await target.acquireLock(lockKey, ttlMs)
          if (lock) locks.set(lockKey, { lock, ttlMs })
          return lock
        }
      }
      if (property === "forceReleaseLock") {
        return async (lockKey: string) => {
          try {
            await target.forceReleaseLock(lockKey)
          }
          finally {
            locks.delete(lockKey)
          }
        }
      }
      if (property === "releaseLock") {
        return async (lock: Lock) => {
          try {
            await target.releaseLock(lock)
          }
          finally {
            if (locks.get(lock.threadId)?.lock.token === lock.token) locks.delete(lock.threadId)
          }
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })

  return {
    refresh(lockKey) {
      const tracked = locks.get(lockKey)
      if (!tracked) return () => undefined
      const interval = setInterval(() => {
        void state.extendLock(tracked.lock, tracked.ttlMs).then((extended) => {
          if (!extended) clearInterval(interval)
        }, () => clearInterval(interval))
      }, Math.max(1, Math.floor(tracked.ttlMs / 3)))
      return () => clearInterval(interval)
    },
    state: trackedState,
  }
}

async function chatSdkLockKey(adapter: Adapter, threadId: string, options: AgentChatOptions | undefined): Promise<string> {
  const channelId = adapter.channelIdFromThreadId(threadId)
  const configuredScope = chatSdkOption<ChatConfig["lockScope"]>(options, "lockScope")
  const scope = typeof configuredScope === "function"
    ? await configuredScope({ adapter, channelId, isDM: adapter.isDM?.(threadId) ?? false, threadId })
    : configuredScope ?? adapter.lockScope ?? "thread"
  return scope === "channel" ? channelId : threadId
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
  const concurrency = chatSdkOption<ChatConfig["concurrency"] | "parallel" | "serial">(options, "concurrency")
  return objectWithoutUndefined({
    adapters: { [adapterName]: adapter },
    concurrency: concurrency === "parallel" ? "concurrent" : concurrency === "serial" ? "queue" : concurrency,
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
const imageAttachmentMimeTypes: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
}

function imageAttachmentMediaType(attachment: Attachment): string | undefined {
  if (attachment.data instanceof Blob && attachment.data.type.startsWith("image/")) return attachment.data.type
  for (const path of [attachment.name, attachment.url]) {
    const extension = path?.split(/[?#]/)[0]?.split(".").pop()?.toLowerCase()
    if (extension && imageAttachmentMimeTypes[extension]) return imageAttachmentMimeTypes[extension]
  }
}

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
  const declaredMediaType = typeof attachment.mimeType === "string" && attachment.mimeType
    ? attachment.mimeType
    : undefined
  const type = declaredMediaType?.startsWith("audio/") || (attachment.type === "audio" && !declaredMediaType)
    ? "audio"
    : declaredMediaType?.startsWith("image/") || (attachment.type === "image" && !declaredMediaType)
      ? "image"
      : "file"
  const mediaType = declaredMediaType
    ?? (type === "image" ? imageAttachmentMediaType(attachment) : undefined)
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
    mediaType: mediaType ?? (type === "audio" ? "audio/ogg" : type === "image" ? "image/jpeg" : "application/octet-stream"),
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
  historyThroughCurrent = false,
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
  let messages = [
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

  if (historyThroughCurrent && current.id) {
    const currentIndex = messages.findIndex(item => item.id === current.id)
    messages = currentIndex >= 0 ? messages.slice(0, currentIndex + 1) : [current]
  }
  else if (!current.id || !messages.some(item => item.id === current.id)) {
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
  toolResults: AgentToolStepItem[],
  abortSignal?: AbortSignal,
  onPost?: () => void,
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
    toolResults: [...toolResults],
    thread: {
      post: async (postedMessage) => {
        await postChatMessage(thread, postedMessage as AgentChatMessage, abortSignal)
        onPost?.()
      },
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

async function postChatMessage(thread: Thread, message: AgentChatMessage, abortSignal?: AbortSignal): Promise<void> {
  if (isAsyncIterable(message)) {
    let markdown = ""
    const stream = (async function* () {
      for await (const chunk of message) {
        markdown += chunk
        yield chunk
      }
    })()
    const sent = await thread.post(thread.adapter.stream ? new StreamingPlan(stream) : stream)
    await removeAbortedChatDelivery(sent, abortSignal)
    await finishDiscordSplitStream(thread, sent, markdown || sentMessageText(sent), abortSignal)
    await removeAbortedChatDelivery(sent, abortSignal)
    return
  }
  if (typeof message !== "object" || message === null) {
    if (await postDiscordSplitContent(thread, message, abortSignal)) return
    await removeAbortedChatDelivery(await thread.post(message), abortSignal)
    return
  }

  const attachments = deliveryArtifactAttachments(chatMessageDeliveryArtifacts(message))
  if (!attachments.length) {
    const postable = isTextChatMessage(message) ? message.text : message as AdapterPostableMessage
    if (await postDiscordSplitContent(thread, postable, abortSignal)) return
    await removeAbortedChatDelivery(await thread.post(postable), abortSignal)
    return
  }

  if (isTextChatMessage(message)) {
    await removeAbortedChatDelivery(await thread.post({ attachments, raw: message.text }), abortSignal)
    return
  }

  const { artifacts: _artifacts, ...postable } = message as Exclude<AgentChatMessage, string | { text: string }> & {
    artifacts?: readonly PublishedAgentDeliveryArtifact[]
    attachments?: unknown
  }
  await removeAbortedChatDelivery(await thread.post({
    ...postable,
    attachments: [
      ...(Array.isArray(postable.attachments) ? postable.attachments as Attachment[] : []),
      ...attachments,
    ],
  } as AdapterPostableMessage), abortSignal)
}

async function replaceManualDeliveryPlaceholder(placeholder: unknown, message: AgentChatMessage): Promise<boolean> {
  if (!placeholder || typeof placeholder !== "object" || !("edit" in placeholder) || typeof placeholder.edit !== "function") return false
  const target = placeholder as { edit: (message: unknown) => Promise<unknown> }
  if (isAsyncIterable(message)) {
    let markdown = ""
    for await (const chunk of message) markdown += chunk
    await target.edit({ markdown })
    return true
  }
  if (typeof message !== "object" || message === null) {
    await target.edit(message)
    return true
  }
  if (deliveryArtifactAttachments(chatMessageDeliveryArtifacts(message)).length) return false
  await target.edit(isTextChatMessage(message) ? message.text : message)
  return true
}

async function deleteManualDeliveryPlaceholder(placeholder: unknown): Promise<void> {
  const message = "Manual chat delivery could not remove its placeholder."
  if (!placeholder || typeof placeholder !== "object" || !("delete" in placeholder) || typeof placeholder.delete !== "function") {
    throw new Error(message)
  }
  try {
    await (placeholder as { delete: () => Promise<unknown> }).delete()
  }
  catch (cause) {
    throw new Error(message, { cause })
  }
}

async function deliverToManualDeliveryPlaceholder(
  placeholder: unknown,
  message: AgentChatMessage,
  beforeDelete?: () => void,
): Promise<boolean> {
  if (!placeholder) return false
  if (await replaceManualDeliveryPlaceholder(placeholder, message).catch(() => false)) return true
  beforeDelete?.()
  await deleteManualDeliveryPlaceholder(placeholder)
  return false
}

async function resolveChatErrorFallbackText(
  options: AgentChatOptions | undefined,
  args: AgentChatErrorHookArgs<ViteAgentRouteRuntimeConfig>,
  resolutionTimeout?: number,
  resolutionAbort?: AbortController,
  callbackDelivered?: () => boolean,
): Promise<string | undefined> {
  const fallback = options?.errorFallbackText
  if (fallback === null) return undefined
  if (typeof fallback === "function") {
    try {
      const resolved = await enforceChatInvocationTimeout(Promise.resolve(fallback(args)), resolutionTimeout, resolutionAbort)
      return resolved || undefined
    }
    catch {
      return callbackDelivered?.() ? undefined : defaultChatErrorFallbackText
    }
  }
  if (typeof fallback === "string") return fallback
  const publicError = toAgentPublicError(args.error, "http")
  if (publicError.code === "RATE_LIMIT_REJECTED") return publicError.error
  return defaultChatErrorFallbackText
}

interface ManualChatDeliveryState {
  errorFallback?: string
  placeholder?: unknown
  placeholderCleanup?: Promise<void>
}

const cloudflareChatBackgroundTimeoutMs = 30_000
const cloudflareChatFallbackTimeoutMs = 2_000
const cloudflareChatInvocationTimeoutMs = cloudflareChatBackgroundTimeoutMs - cloudflareChatFallbackTimeoutMs
const chatFallbackDeliveryReserveMs = 1_000

async function postChatErrorFallback(
  error: unknown,
  thread: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
  input: AgentChatMessageTriggerInput | undefined,
  run: AgentRunMetadata | undefined,
  toolResults: AgentToolStepItem[],
  manualDelivery?: ManualChatDeliveryState,
  maximumInvocationDeadline?: number,
): Promise<void> {
  console.error({
    component: "@vite-hub/agent",
    error: serializeErrorForLog(error),
    event: "chat.message.error",
    message_id: message.id,
    thread_id: message.threadId,
  })
  const fallbackResolutionTimeout = maximumInvocationDeadline === undefined
    ? undefined
    : Math.max(0, maximumInvocationDeadline + cloudflareChatFallbackTimeoutMs - chatFallbackDeliveryReserveMs - Date.now())
  let callbackDelivered = false
  let resolveCallbackDelivery: (() => void) | undefined
  const callbackDelivery = new Promise<void>((resolve) => {
    resolveCallbackDelivery = resolve
  })
  const fallbackResolutionAbort = maximumInvocationDeadline === undefined ? undefined : new AbortController()
  const fallbackResolution = resolveChatErrorFallbackText(
    options,
    chatErrorHookArgs(thread, message, input, run, error, toolResults, fallbackResolutionAbort?.signal, () => {
      callbackDelivered = true
      resolveCallbackDelivery?.()
    }),
    fallbackResolutionTimeout,
    fallbackResolutionAbort,
    () => callbackDelivered,
  )
  const fallback = typeof options?.errorFallbackText === "function"
    ? await Promise.race([fallbackResolution, callbackDelivery.then(() => undefined)])
    : await fallbackResolution
  if (callbackDelivered) fallbackResolutionAbort?.abort()
  if (fallback && manualDelivery) manualDelivery.errorFallback = fallback
  if (manualDelivery?.placeholderCleanup) {
    const cleanup = manualDelivery.placeholderCleanup.catch(() => undefined)
    if (maximumInvocationDeadline === undefined) await cleanup
    else {
      await enforceChatInvocationTimeout(
        cleanup,
        Math.max(0, maximumInvocationDeadline + cloudflareChatFallbackTimeoutMs - chatFallbackDeliveryReserveMs - Date.now()),
      ).catch(() => undefined)
    }
  }
  const fallbackPlaceholder = manualDelivery?.placeholderCleanup ? undefined : manualDelivery?.placeholder
  const fallbackDeliveryAbort = maximumInvocationDeadline === undefined ? undefined : new AbortController()
  const fallbackDelivery = (async () => {
    if (!fallback) {
      if (fallbackPlaceholder) await deleteManualDeliveryPlaceholder(fallbackPlaceholder)
      return
    }
    if (await deliverToManualDeliveryPlaceholder(fallbackPlaceholder, fallback)) return
    fallbackDeliveryAbort?.signal.throwIfAborted()
    const sent = await thread.post(fallback).catch(() => undefined)
    if (!sent) return
    if (fallbackDeliveryAbort?.signal.aborted) {
      await deleteManualDeliveryPlaceholder(sent)
      fallbackDeliveryAbort.signal.throwIfAborted()
    }
  })()
  if (maximumInvocationDeadline === undefined) await fallbackDelivery
  else {
    await enforceChatInvocationTimeout(
      fallbackDelivery,
      Math.max(0, maximumInvocationDeadline + cloudflareChatFallbackTimeoutMs - Date.now()),
      fallbackDeliveryAbort,
    ).catch(() => undefined)
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

async function* abortableChatMessage(
  message: AsyncIterable<string>,
  abortSignal: AbortSignal,
): AsyncIterable<string> {
  const iterator = message[Symbol.asyncIterator]()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await iterator.return?.().catch(() => undefined)
  }
  try {
    while (true) {
      abortSignal.throwIfAborted()
      const next = await new Promise<IteratorResult<string>>((resolve, reject) => {
        const onAbort = () => {
          void close()
          reject(abortSignal.reason)
        }
        abortSignal.addEventListener("abort", onAbort, { once: true })
        iterator.next().then(resolve, reject).finally(() => {
          abortSignal.removeEventListener("abort", onAbort)
        })
      })
      if (next.done) return
      yield next.value
    }
  }
  finally {
    await close()
  }
}

async function collectAbortableChatMessage(
  message: AsyncIterable<string>,
  abortSignal: AbortSignal,
): Promise<{ markdown: string }> {
  let markdown = ""
  for await (const chunk of abortableChatMessage(message, abortSignal)) markdown += chunk
  return { markdown }
}

async function flushChatFinishExtensionMessages(
  thread: Thread,
  chat: AgentChatQueuedFinishExtension,
  manualDelivery: ManualChatDeliveryState,
  abortSignal?: AbortSignal,
): Promise<void> {
  const messages = chat[chatFinishMessagesKey].splice(0)
  for (let message of messages) {
    abortSignal?.throwIfAborted()
    if (abortSignal && isAsyncIterable(message)) {
      message = manualDelivery.placeholder
        ? await collectAbortableChatMessage(message, abortSignal)
        : abortableChatMessage(message, abortSignal)
    }
    if (manualDelivery.placeholder) {
      if (isAsyncIterable(message)) {
        let markdown = ""
        for await (const chunk of message) markdown += chunk
        message = { markdown }
        abortSignal?.throwIfAborted()
      }
      const placeholder = manualDelivery.placeholder
      let deliveredToPlaceholder = false
      const placeholderCleanup = (async () => {
        try {
          await deleteManualDeliveryPlaceholder(placeholder)
        }
        catch {
          abortSignal?.throwIfAborted()
          deliveredToPlaceholder = await replaceManualDeliveryPlaceholder(placeholder, message).catch(() => false)
          abortSignal?.throwIfAborted()
        }
        manualDelivery.placeholder = undefined
        abortSignal?.throwIfAborted()
      })()
      manualDelivery.placeholderCleanup = placeholderCleanup
      try {
        await placeholderCleanup
      }
      finally {
        if (manualDelivery.placeholderCleanup === placeholderCleanup) {
          manualDelivery.placeholderCleanup = undefined
        }
      }
      if (deliveredToPlaceholder) continue
    }
    await postChatMessage(thread, message, abortSignal)
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

function chatInvocationTimeout(
  timeout: number | undefined,
  maximum: number | undefined,
): number | undefined {
  if (maximum === undefined) return timeout
  return timeout === undefined ? maximum : Math.min(timeout, maximum)
}

async function enforceChatInvocationTimeout<T>(
  task: Promise<T>,
  timeout: number | undefined,
  abortController?: AbortController,
): Promise<T> {
  if (timeout === undefined) return await task
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(`Chat invocation timed out after ${timeout}ms.`)
          abortController?.abort(error)
          reject(error)
        }, timeout)
      }),
    ])
  }
  finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function handleChatSdkMessage(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  thread: Thread,
  message: ChatSdkMessage,
  deliveryKind: AgentMessageDeliveryKind,
  options: AgentChatOptions | undefined,
  state: { keyPrefix: string, state: StateAdapter },
  messageContext?: MessageContext,
  maximumInvocationDeadline?: number,
  historyThroughCurrent = false,
): Promise<void> {
  let input: AgentChatMessageTriggerInput | undefined
  let run: AgentRunMetadata | undefined
  let typing: ChatTypingRefresh | undefined
  let progress: ReturnType<typeof createManualDeliveryProgressUpdater> | undefined
  const manualDeliveryState: ManualChatDeliveryState = {}
  const toolResults: AgentToolStepItem[] = []
  const invocationDeadlineAbort = maximumInvocationDeadline === undefined ? undefined : new AbortController()
  try {
    input = createChatTriggerInput(chatRegistrationOrigin(registration), thread, message, [chatAuthorizationUiMessage(thread, message, messageContext)], messageContext, registration.channelId)
    if (typeof options?.timeout === "number" && Number.isFinite(options.timeout) && options.timeout > 0) {
      input.timeout = options.timeout
    }
    const authorizationInput = createChatMessageTriggerInput(options || {}, input).input
    const invoker = await isChatMessageAuthorized(agent, context, registration, thread, message, authorizationInput, input.run, messageContext)
    if (!invoker) return

    const messages = await chatTriggerMessages(thread, message, options, messageContext, historyThroughCurrent)
    const currentMessage = message.id
      ? messages.find(item => item.id === message.id)
      : messages.at(-1)
    if (!currentMessage || !Array.isArray(currentMessage.parts) || currentMessage.parts.length === 0) return
    const filter = options?.filter
    if (filter) {
      const [current] = uiMessagesToAgentMessages([currentMessage])
      if (!current || !await filter({
        ...context,
        deliveryKind,
        message: current,
        run: input.run,
        thread: {
          post: async postedMessage => await postChatMessage(thread, postedMessage),
        },
      })) return
    }
    input = { ...input, messages }
    const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, "chat.message", input)
    if (isResolvedAgentTriggerHandledInvocation(invocation)) return

    assertChatDeliveryOptions(options || {})
    const manualDelivery = options?.delivery === "manual"
    const streamsPhasedReplies = !manualDelivery && (options?.stream !== false || options?.commentary !== undefined)
    run = invocation.run
    const runContext = {
      ...context,
      ...(invocation.run ? { run: invocation.run } : {}),
    }
    const durableDelivery = manualDelivery && options?.durable !== false && (
      options?.durable === true
      || (options?.concurrency === undefined || options.concurrency === "parallel")
      && await hasActiveWorkflowRuntime(agent as never, runContext as never, true)
    )
    const resolvedInvocationInput = invocation.input as AgentRunInput
    if (durableDelivery) {
      const durableTyping = startChatTypingRefresh(thread, context)
      const durableTypingTimeout = setTimeout(() => durableTyping.stop(), options?.timeout ?? 28_000)
      try {
        await runAgent(agent as never, runContext as never, withResolvedAgentInvokerInput({
          ...resolvedInvocationInput,
          context: {
            ...resolvedInvocationInput.context,
            [finalChannelOutputContextKey]: true,
            [requireAgentWorkflowContextKey]: true,
          },
        }, invoker) as never)
      }
      catch (error) {
        clearTimeout(durableTypingTimeout)
        durableTyping.stop()
        throw error
      }
      return
    }
    typing = streamsPhasedReplies || manualDelivery ? startChatTypingRefresh(thread, context) : undefined
    const thinkingFallback = invocation.metadata?.thinkingFallback
    if (manualDelivery && typeof thinkingFallback === "string") {
      const placeholderDelivery = thread.post(thinkingFallback).then(async (placeholder) => {
        if (invocationDeadlineAbort?.signal.aborted) {
          await deleteManualDeliveryPlaceholder(placeholder)
          invocationDeadlineAbort.signal.throwIfAborted()
        }
        return placeholder
      })
      manualDeliveryState.placeholder = await enforceChatInvocationTimeout(
        placeholderDelivery,
        maximumInvocationDeadline === undefined ? undefined : Math.max(0, maximumInvocationDeadline - Date.now()),
        invocationDeadlineAbort,
      )
    }
    const chatFinish = createChatFinishExtension(input, registration)
    progress = manualDelivery
      ? createManualDeliveryProgressUpdater(manualDeliveryState, context.waitUntil, invocationDeadlineAbort?.signal)
      : undefined
    const remainingMaximumInvocationTimeout = maximumInvocationDeadline === undefined
      ? undefined
      : Math.max(0, maximumInvocationDeadline - Date.now())
    const invocationInput = withChatFinishExtension(withResolvedAgentInvokerInput({
      ...resolvedInvocationInput,
      ...(invocationDeadlineAbort
        ? {
            abortSignal: resolvedInvocationInput.abortSignal
              ? AbortSignal.any([resolvedInvocationInput.abortSignal, invocationDeadlineAbort.signal])
              : invocationDeadlineAbort.signal,
          }
        : {}),
      timeout: chatInvocationTimeout(resolvedInvocationInput.timeout, remainingMaximumInvocationTimeout),
      context: {
        ...resolvedInvocationInput.context,
        [messageChannelStateContextKey]: state,
        ...(progress
          ? {
              [agentOutputEventObserverContextKey]: (event: unknown) => {
                const summary = progressSummaryFromEvent(event)
                if (summary) progress?.update(summary)
              },
            }
          : {}),
        ...(options?.stream === false || manualDelivery ? { [finalChannelOutputContextKey]: true } : {}),
      },
    }, invoker), chatFinish)
    if (!streamsPhasedReplies) {
      // Manual delivery disables Chat SDK reply streaming, but still consumes
      // normalized Agent events so transient Capability output can update the
      // framework-owned placeholder without exposing ordinary Agent text.
      await enforceChatInvocationTimeout(
        (async () => {
          const result = manualDelivery
            ? await streamAgent(agent as never, runContext as never, invocationInput as never, { output: "events" })
            : await runAgentInline(agent as never, runContext as never, invocationInput as never)
          const text = await collectAgentOutput(result, progress?.update, toolResult => toolResults.push(toolResult))
          if (!manualDelivery && text) {
            invocationDeadlineAbort?.signal.throwIfAborted()
            if (!await postDiscordSplitContent(thread, { markdown: text }, invocationDeadlineAbort?.signal)) {
              const sent = await thread.post({ markdown: text })
              if (invocationDeadlineAbort?.signal.aborted) {
                await deleteManualDeliveryPlaceholder(sent)
                invocationDeadlineAbort.signal.throwIfAborted()
              }
            }
          }
          await progress?.finish()
          await flushChatFinishExtensionMessages(thread, chatFinish, manualDeliveryState, invocationDeadlineAbort?.signal)
          invocationDeadlineAbort?.signal.throwIfAborted()
          const completedPlaceholder = manualDeliveryState.placeholder
          if (completedPlaceholder) {
            const placeholderCleanup = deleteManualDeliveryPlaceholder(completedPlaceholder)
            manualDeliveryState.placeholderCleanup = placeholderCleanup
            try {
              await placeholderCleanup
              if (manualDeliveryState.placeholder === completedPlaceholder) {
                manualDeliveryState.placeholder = undefined
              }
            }
            finally {
              if (manualDeliveryState.placeholderCleanup === placeholderCleanup) {
                manualDeliveryState.placeholderCleanup = undefined
              }
            }
          }
        })(),
        maximumInvocationDeadline === undefined ? undefined : invocationInput.timeout,
        invocationDeadlineAbort,
      )
    }
    else {
      await enforceChatInvocationTimeout((async () => {
        const result = streamAgent(agent as never, runContext as never, invocationInput as never, {
          output: "events",
        })
        try {
          if (options?.stream === true || options?.commentary === undefined) {
            await postChatStream(
              thread,
              streamAgentOutputToChatText(result, toolResult => toolResults.push(toolResult)),
              typeof thinkingFallback === "string" || thinkingFallback === null ? thinkingFallback : undefined,
              context.waitUntil,
              invocationDeadlineAbort?.signal,
              maximumInvocationDeadline,
            )
          }
          else {
            const commentaryDeliveries: Promise<void>[] | undefined = maximumInvocationDeadline === undefined ? undefined : []
            let finalDelivery: Promise<void> | undefined
            let finalDeliveryError: unknown
            const replies = streamAgentOutputToChatReplies(result, {
              commentary: options.commentary,
              onToolResult: toolResult => toolResults.push(toolResult),
              onCommentary(response, discard) {
                const delivery = postChatStream(thread, response, undefined, context.waitUntil, invocationDeadlineAbort?.signal, maximumInvocationDeadline)
                  .catch(() => discard())
                commentaryDeliveries?.push(delivery)
                context.waitUntil(delivery)
              },
              onFinal(response) {
                finalDelivery = postChatStream(
                  thread,
                  response,
                  typeof thinkingFallback === "string" || thinkingFallback === null ? thinkingFallback : undefined,
                  context.waitUntil,
                  invocationDeadlineAbort?.signal,
                  maximumInvocationDeadline,
                ).catch((error) => {
                  finalDeliveryError = error
                })
              },
            })
            let streamError: unknown
            await replies.completion.catch((error) => {
              streamError = error
            })
            if (commentaryDeliveries) await Promise.all(commentaryDeliveries)
            await finalDelivery
            if (streamError !== undefined) throw streamError
            if (finalDeliveryError !== undefined) throw finalDeliveryError
          }
        }
        finally {
          typing?.stop()
        }
        await flushChatFinishExtensionMessages(thread, chatFinish, manualDeliveryState, invocationDeadlineAbort?.signal)
      })(), maximumInvocationDeadline === undefined ? undefined : invocationInput.timeout, invocationDeadlineAbort)
    }
  }
  catch (error) {
    typing?.stop()
    await progress?.finish()
    await postChatErrorFallback(error, thread, message, options, input, run, toolResults, manualDeliveryState, maximumInvocationDeadline)
    throw error
  }
  finally {
    typing?.stop()
  }
}

type AgentMessageDeliveryKindResolver =
  (message: ChatSdkMessage) => MaybePromise<AgentMessageDeliveryKind | undefined>

function createChatSdkMessageThread(
  chat: Chat,
  adapter: Adapter,
  state: StateAdapter,
  source: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
): Thread {
  const fallbackStreamingPlaceholderText = typeof options?.fallbackStreamingPlaceholderText === "string"
    ? options.fallbackStreamingPlaceholderText
    : options?.fallbackStreamingPlaceholderText === null ? null : undefined
  return new ThreadImpl({
    adapter,
    channelId: adapter.channelIdFromThreadId(message.threadId),
    channelVisibility: adapter.getChannelVisibility?.(message.threadId),
    currentMessage: message,
    fallbackStreamingPlaceholderText,
    id: message.threadId,
    initialMessage: message,
    isDM: adapter.isDM?.(message.threadId) ?? false,
    logger: chat.getLogger(),
    stateAdapter: state,
    streamingUpdateIntervalMs: chatSdkOption<number>(options, "streamingUpdateIntervalMs"),
    threadHistory: chatThreadHistoryCache(source) as never,
  })
}

async function serialMessageDeliveryKind(thread: Thread, message: ChatSdkMessage): Promise<AgentMessageDeliveryKind | undefined> {
  if (thread.isDM) return "direct"
  if (await thread.isSubscribed()) return message.isMention ? "mention" : "subscribed"
  if (!message.isMention) return
  await thread.subscribe().catch(() => undefined)
  return "mention"
}

async function handleChatSdkMessages(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  thread: Thread,
  message: ChatSdkMessage,
  resolveDeliveryKind: AgentMessageDeliveryKindResolver,
  options: AgentChatOptions | undefined,
  state: { keyPrefix: string, state: StateAdapter },
  adapter: Adapter,
  chat: Chat,
  lockTracker: ChatLockTracker,
  messageContext?: MessageContext,
  maximumInvocationDeadline?: number,
): Promise<void> {
  const serial = chatSdkOption<string>(options, "concurrency") === "serial"
  const messages = serial ? [...messageContext?.skipped ?? [], message] : [message]
  const stopRefreshingLock = serial
    ? lockTracker.refresh(await chatSdkLockKey(adapter, thread.id, options))
    : () => undefined

  try {
    for (const queuedMessage of messages) {
      try {
        const queuedThread = serial
          ? createChatSdkMessageThread(chat, adapter, state.state, thread, queuedMessage, options)
          : thread
        const deliveryKind = serial
          ? await serialMessageDeliveryKind(queuedThread, queuedMessage)
          : await resolveDeliveryKind(queuedMessage)
        if (!deliveryKind) continue
        await handleChatSdkMessage(
          agent,
          context,
          registration,
          queuedThread,
          queuedMessage,
          deliveryKind,
          options,
          state,
          serial ? undefined : messageContext,
          maximumInvocationDeadline,
          serial,
        )
      }
      catch (error) {
        if (!serial) throw error
      }
    }
  }
  finally {
    stopRefreshingLock()
  }
}

async function createChannelChat(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  adapterName: string,
  adapter: Adapter,
  options: AgentChatOptions | undefined,
  handlerOptions: AgentChannelWebhookRouteOptions,
  maximumInvocationDeadline?: number,
): Promise<Chat> {
  const resolvedState = await resolveChatState(options, context, registration, handlerOptions)
  const lockTracker = createChatLockTracker(resolvedState.state)
  const chat = new Chat(createChatSdkConfig(
    adapterName,
    adapter,
    lockTracker.state,
    options,
  ))
  const state = { keyPrefix: resolvedState.titleKeyPrefix, state: resolvedState.state }
  chat.onDirectMessage((thread, message, _channel, messageContext) =>
    handleChatSdkMessages(agent, context, registration, thread, message, () => "direct", options, state, adapter, chat, lockTracker, messageContext, maximumInvocationDeadline))
  chat.onNewMention(async (thread, message, messageContext) => {
    if (chatSdkOption<string>(options, "concurrency") !== "serial") {
      await thread.subscribe().catch(() => undefined)
      await handleChatSdkMessages(agent, context, registration, thread, message, () => "mention", options, state, adapter, chat, lockTracker, messageContext, maximumInvocationDeadline)
      return
    }
    await handleChatSdkMessages(agent, context, registration, thread, message, () => "mention", options, state, adapter, chat, lockTracker, messageContext, maximumInvocationDeadline)
  })
  chat.onSubscribedMessage((thread, message, messageContext) =>
    handleChatSdkMessages(agent, context, registration, thread, message, queuedMessage => queuedMessage.isMention ? "mention" : "subscribed", options, state, adapter, chat, lockTracker, messageContext, maximumInvocationDeadline))

  return chat
}

async function createChatWebhookHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  adapterName: string,
  adapter: Adapter,
  options: AgentChatOptions | undefined,
  handlerOptions: AgentChannelWebhookRouteOptions,
  maximumInvocationDeadline?: number,
): Promise<(request: Request, webhookOptions: WebhookOptions) => Promise<Response>> {
  const chat = await createChannelChat(agent, context, registration, adapterName, adapter, options, handlerOptions, maximumInvocationDeadline)
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
    if (!isRecord(body) || Array.isArray(body)) throw createRouteBodyError("Agent chat payload must be a JSON object.")
    return { body, rawBody: raw }
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

function validateAgentChannelChatRouteBody(body: AgentChannelChatRouteBody): AgentChannelChatRouteBody & { messages: UIMessage[] } {
  optionalBodyString(body.id, "id")
  optionalBodyString(body.messageId, "messageId")
  optionalBodyString(body.trigger, "trigger")
  if (!Array.isArray(body.messages)) {
    throw createRouteBodyError("Agent chat payload requires a messages array.")
  }
  if (!body.messages.length) {
    throw createRouteBodyError("Agent chat payload requires at least one message.")
  }
  for (const [index, message] of body.messages.entries()) {
    if (!isRecord(message) || Array.isArray(message)) {
      throw createRouteBodyError(`Agent chat payload message ${index + 1} must be an object.`)
    }
    if (message.role !== "user" && message.role !== "assistant") {
      throw createRouteBodyError(`Agent chat payload message ${index + 1} role must be "user" or "assistant".`)
    }
  }
  return body as AgentChannelChatRouteBody & { messages: UIMessage[] }
}

async function parseAgentChannelChatRouteAdmissionBody<TBody extends AgentChannelChatRouteBody>(
  body: AgentChannelChatRouteBody,
  schema: AgentChannelChatRouteStandardSchemaV1<TBody> | undefined,
): Promise<TBody> {
  const validatedBody = validateAgentChannelChatRouteBody(body)
  if (!schema) return validatedBody as TBody
  try {
    return await parseStandardSchema(schema, validatedBody, "agent chat route body")
  }
  catch (error) {
    throw createRouteBodyError(error instanceof Error ? error.message : "Invalid agent chat route body.")
  }
}

function agentChannelChatRouteInput(
  body: AgentChannelChatRouteBody,
  agentName: string,
  allowTrustedInput = false,
  options: Pick<AgentChannelChatRouteHandlerOptions, "channelId" | "origin"> = {},
): AgentChatMessageTriggerInput {
  const { messages } = validateAgentChannelChatRouteBody(body)
  if (!allowTrustedInput && ("invoker" in body || "invokerProfileId" in body || "meta" in body || "run" in body || "session" in body || "timeout" in body || "user" in body)) {
    throw createRouteBodyError("Agent chat route identity must be derived server-side with defineAgent({ invoker }).")
  }
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
    resumable: options.resumable ?? channelOptions?.resumable,
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
  if (result instanceof Response || isResponseLike(result)) {
    return withCleanUiMessageStreamResponse(result)
  }
  return createAgentUIMessageStreamResponse({ stream: readableStreamFromResult(result) })
}

interface AgentChatPendingApproval {
  id: string
  input?: unknown
  name: string
  toolCallId: string
}

interface AgentChatConsumedApproval extends AgentChatPendingApproval {
  approved: boolean
  reason?: string
}

function isAgentChatConsumedApproval(value: unknown): value is AgentChatConsumedApproval {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.toolCallId === "string"
    && typeof value.approved === "boolean"
}

const agentChatApprovalTtlMs = 24 * 60 * 60 * 1000

function agentChatApprovalKey(invokerId: string, sessionId: string, approvalId?: string): string {
  const session = `invoker:${encodeURIComponent(invokerId)}:session:${encodeURIComponent(sessionId)}:approval`
  return approvalId ? `${session}:${encodeURIComponent(approvalId)}` : session
}

function agentChatApprovedToolsKey(invokerId: string, sessionId: string): string {
  return `invoker:${encodeURIComponent(invokerId)}:session:${encodeURIComponent(sessionId)}:eve:approved-tools`
}

function agentChatSessionBoundaryKey(invokerId: string, sessionId: string, manualId: string): string {
  return `invoker:${encodeURIComponent(invokerId)}:session:${encodeURIComponent(sessionId)}:manual:${encodeURIComponent(manualId)}:boundary`
}

function agentChatConsumedApprovalKey(invokerId: string, sessionId: string, approvalId: string): string {
  return `${agentChatApprovalKey(invokerId, sessionId, approvalId)}:consumed`
}

async function withAgentChatApprovalLock<T>(state: StateAdapter, invokerId: string, sessionId: string, callback: () => Promise<T>): Promise<T> {
  const lock = await state.acquireLock(`${agentChatApprovalKey(invokerId, sessionId)}:lock`, 10_000)
  if (!lock) throw createRouteError(409, "Agent chat session is already handling an approval response.")
  try {
    return await callback()
  }
  finally {
    await state.releaseLock(lock)
  }
}

function uiApprovalPart(part: unknown): { approval: Record<string, unknown>, record: Record<string, unknown> } | undefined {
  if (!isRecord(part)) return
  const type = part.type
  if (type !== "dynamic-tool" && !(typeof type === "string" && type.startsWith("tool-"))) return
  if (part.state !== "approval-requested" && part.state !== "approval-responded") return
  if (!isRecord(part.approval) || typeof part.approval.id !== "string") return
  return { approval: part.approval, record: part }
}

async function authorizeAgentChatApprovals(
  state: StateAdapter,
  invokerId: string,
  sessionId: string,
  messages: UIMessageLike[],
  persistApprovedTools = true,
  ttlMs = agentChatApprovalTtlMs,
): Promise<{ approvedTools: string[], messages: UIMessageLike[] }> {
  const submitted = messages.flatMap((message, messageIndex) => (message.parts || []).flatMap(part => {
    const approvalPart = uiApprovalPart(part)
    return approvalPart ? [{ ...approvalPart, historical: messageIndex < messages.length - 1 }] : []
  }))
  if (!submitted.length) return { approvedTools: [], messages }

  return await withAgentChatApprovalLock(state, invokerId, sessionId, async () => {
    const pending = new Map(await Promise.all([...new Set(submitted.map(part => part.approval.id as string))].map(async id => [
      id,
      await state.get<AgentChatPendingApproval>(agentChatApprovalKey(invokerId, sessionId, id)),
    ] as const)))
    const historical = new Map(await Promise.all([...new Set(submitted.filter(part => part.historical).map(part => part.approval.id as string))].map(async id => {
      const value = await state.get<AgentChatConsumedApproval>(agentChatConsumedApprovalKey(invokerId, sessionId, id))
      return [id, isAgentChatConsumedApproval(value) ? value : undefined] as const
    })))
    const consumed = new Set<string>()
    const authorized = messages.map((message, messageIndex) => ({
      ...message,
      parts: (message.parts || []).filter((part) => {
        const submittedPart = uiApprovalPart(part)
        if (!submittedPart || messageIndex === messages.length - 1) return true
        const id = submittedPart.approval.id as string
        return Boolean(pending.get(id) || historical.get(id))
      }).map((part) => {
        const submittedPart = uiApprovalPart(part)
        if (!submittedPart) return part
        const id = submittedPart.approval.id as string
        const historicalDecision = historical.get(id)
        const request = pending.get(id) ?? (messageIndex < messages.length - 1 ? historicalDecision : undefined)
        if (!request) throw createRouteBodyError(`Agent chat approval ${JSON.stringify(id)} was not issued by this session.`)
        if (submittedPart.record.state === "approval-responded") {
          if (typeof submittedPart.approval.approved !== "boolean") {
            throw createRouteBodyError(`Agent chat approval ${JSON.stringify(id)} requires an approved decision.`)
          }
          if (consumed.has(id)) throw createRouteBodyError(`Agent chat approval ${JSON.stringify(id)} was submitted more than once.`)
          consumed.add(id)
        }
        return {
          ...submittedPart.record,
          approval: {
            id,
            ...(typeof submittedPart.approval.approved === "boolean"
              ? { approved: historicalDecision?.approved ?? submittedPart.approval.approved }
              : {}),
            ...(typeof (historicalDecision?.reason ?? submittedPart.approval.reason) === "string"
              ? { reason: historicalDecision?.reason ?? submittedPart.approval.reason }
              : {}),
          },
          input: request.input,
          toolCallId: request.toolCallId,
          toolName: request.name,
        }
      }),
    })).filter(message => message.parts.length > 0)

    const newlyApproved = submitted.flatMap((part) => {
      const id = part.approval.id as string
      const request = pending.get(id)
      return part.record.state === "approval-responded" && part.approval.approved === true && request ? [request.name] : []
    })
    if (persistApprovedTools && newlyApproved.length) {
      const approved = await state.get<string[]>(agentChatApprovedToolsKey(invokerId, sessionId))
      await state.set(
        agentChatApprovedToolsKey(invokerId, sessionId),
        [...new Set([...(approved ?? []), ...newlyApproved])],
        ttlMs,
      )
    }
    await Promise.all([...consumed].map(async (id) => {
      const request = pending.get(id)
      const decision = submitted.find(part => part.approval.id === id && part.record.state === "approval-responded")?.approval
      if (request && typeof decision?.approved === "boolean") {
        await state.set(agentChatConsumedApprovalKey(invokerId, sessionId, id), {
          ...request,
          approved: decision.approved,
          ...(typeof decision.reason === "string" ? { reason: decision.reason } : {}),
        } satisfies AgentChatConsumedApproval, ttlMs)
      }
    }))
    await Promise.all([...consumed].map(id => state.delete(agentChatApprovalKey(invokerId, sessionId, id))))
    return { approvedTools: [...new Set(newlyApproved)], messages: authorized }
  })
}

function trackAgentChatApprovals(result: unknown, state: StateAdapter, invokerId: string, sessionId: string, ttlMs = agentChatApprovalTtlMs): unknown {
  const toolInputs = new Map<string, { input?: unknown, name?: string }>()

  async function trackChunk(value: unknown): Promise<void> {
    if (!isRecord(value)) return
    const type = value.type
    const toolCallId = firstString(value.toolCallId, value.id)
    if ((type === "tool-input-available" || type === "tool-call") && toolCallId) {
      toolInputs.set(toolCallId, {
        input: value.input,
        name: firstString(value.toolName, value.name),
      })
    }
    if (type !== "tool-approval-request" || !toolCallId) return
    const id = firstString(value.approvalId, value.id)
    if (!id) return
    const tool = toolInputs.get(toolCallId)
    await state.set(
      agentChatApprovalKey(invokerId, sessionId, id),
      {
        id,
        input: tool?.input ?? value.input,
        name: firstString(value.toolName, tool?.name) || "tool",
        toolCallId,
      } satisfies AgentChatPendingApproval,
      ttlMs,
    )
  }

  function trackedStream(stream: ReadableStream<unknown>, framed = false): ReadableStream<unknown> {
    const reader = stream.getReader()
    const decoder = framed ? new TextDecoder() : undefined
    let pending = ""
    return new ReadableStream({
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) {
            if (decoder) pending += decoder.decode()
            controller.close()
            return
          }
          if (decoder) {
            pending += decoder.decode(chunk.value as Uint8Array, { stream: true })
            const events = pending.split(/\r?\n\r?\n/)
            pending = events.pop() || ""
            for (const event of events) {
              const data = event.split(/\r?\n/)
                .filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart())
                .join("\n")
              if (data && data !== "[DONE]") {
                try {
                  await trackChunk(JSON.parse(data))
                }
                catch (error) {
                  if (!(error instanceof SyntaxError)) throw error
                }
              }
            }
          }
          else await trackChunk(chunk.value)
          controller.enqueue(chunk.value)
        }
        catch (error) {
          controller.error(error)
        }
      },
      async cancel(reason) {
        await reader.cancel(reason)
      },
    })
  }

  if (result instanceof Response || isResponseLike(result)) {
    if (!result.body || !isUiMessageStreamResponse(result)) return result
    const headers = new Headers([...result.headers.entries()])
    headers.delete("content-encoding")
    headers.delete("content-length")
    return new Response(trackedStream(result.body, true) as ReadableStream<Uint8Array>, {
      headers,
      status: result.status,
      statusText: result.statusText,
    })
  }
  if (!isReadableStreamLike(result)) return result
  return trackedStream(result)
}

function agentChatFetchErrorResponse(error: unknown): Response {
  const response = toHttpErrorResponse(error)
  if (response) return response
  return toHttpErrorResponse(error, error instanceof TypeError ? 400 : 500)!
}

function resumableChatError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(typeof error === "string" && error ? error : "[vitehub] Resumable web chat failed.", { cause: error })
}

function normalizeResumableChatStreamResponse(response: Response, messageId: string): Response {
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response
  let started = false
  const stream = uiMessageStreamFromResponse(response as Response & { body: ReadableStream<Uint8Array> }).pipeThrough(new TransformStream<unknown, unknown>({
    transform(part, controller) {
      if (isRecord(part) && part.type === "start") {
        started = true
        controller.enqueue({ ...part, messageId })
        return
      }
      if (!started) {
        started = true
        controller.enqueue({ messageId, type: "start" })
      }
      controller.enqueue(part)
    },
  }))
  const headers = new Headers(response.headers)
  headers.delete("content-encoding")
  headers.delete("content-length")
  return createAgentUIMessageStreamResponse({
    headers,
    status: response.status,
    statusText: response.statusText,
    stream,
  })
}

interface ResumableChatRun {
  abortController: AbortController
  bufferedBytes: number
  cancelled: boolean
  chunks: Uint8Array[]
  cleanup?: ReturnType<typeof setTimeout>
  consume?: Promise<void>
  done: boolean
  error?: unknown
  headers?: Headers
  invocationKey: string
  latestKey: string
  owner: string
  reader?: ReadableStreamDefaultReader<Uint8Array>
  ready: Promise<void>
  requestSequence: number
  replaySubscribers: number
  replaySubscriberReleases: Set<() => void>
  resolveReady: () => void
  released: boolean
  setupError?: unknown
  status: number
  statusText: string
  subscribers: Set<ReadableStreamDefaultController<Uint8Array>>
}

const resumableChatMaxBufferedBytes = 8 * 1024 * 1024
const resumableChatMaxOwnerBufferedBytes = 64 * 1024 * 1024
const resumableChatMaxTotalBufferedBytes = 512 * 1024 * 1024
const resumableChatMaxRuns = 100
const resumableChatMaxSubscribers = 100
const resumableChatMaxTotalRuns = 10_000
const resumableChatMaxPendingClaims = 100
const resumableChatMaxTotalPendingClaims = 10_000
const resumableChatMaxPendingLookups = 100
const resumableChatMaxTotalPendingLookups = 10_000
const resumableChatMaxTotalPendingOwnerResolutions = 10_000
const resumableChatMaxOwnerTombstones = 100
const resumableChatMaxTombstones = 10_000

function resumableChatResponse(run: ResumableChatRun): Response {
  if (run.released) return new Response(null, { status: 204 })
  if (run.subscribers.size + run.replaySubscribers >= resumableChatMaxSubscribers) {
    return createJsonErrorResponse(429, "Resumable web chat has too many live subscribers. Try again later.")
  }
  if (run.done) {
    let chunks = run.chunks
    let chunkIndex = 0
    let released = false
    const release = () => {
      if (released) return
      released = true
      run.replaySubscribers--
      run.replaySubscriberReleases.delete(terminate)
      chunks = []
    }
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const terminate = () => {
      release()
      try {
        streamController?.error(new Error("[vitehub] Resumable web chat replay was released before delivery completed."))
      }
      catch {}
    }
    run.replaySubscribers++
    run.replaySubscriberReleases.add(terminate)
    return new Response(new ReadableStream<Uint8Array>({
      cancel: release,
      start(controller) {
        streamController = controller
      },
      pull(controller) {
        const chunk = chunks[chunkIndex++]
        if (chunk) {
          controller.enqueue(chunk)
          return
        }
        release()
        if (run.error) controller.error(run.error)
        else controller.close()
      },
    }), {
      headers: run.headers,
      status: run.status,
      statusText: run.statusText,
    })
  }
  let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of run.chunks) controller.enqueue(chunk)
      if (run.error) controller.error(run.error)
      else if (run.done) controller.close()
      else {
        subscriber = controller
        run.subscribers.add(controller)
      }
    },
    cancel() {
      if (subscriber) run.subscribers.delete(subscriber)
    },
  }), {
    headers: run.headers,
    status: run.status,
    statusText: run.statusText,
  })
}

async function resumableChatOwner(
  config: AgentChannelChatRouteResumableOptions | undefined,
  context: AgentChannelChatRouteResumableContext,
): Promise<string> {
  if (!config || typeof config !== "object" || typeof config.owner !== "function") {
    throw new TypeError("[vitehub] Resumable web chat requires route.resumable.owner().")
  }
  const owner = await config.owner(context)
  if (typeof owner !== "string" || !owner.trim()) {
    throw new TypeError("[vitehub] Resumable web chat owner must be a non-empty string.")
  }
  return owner
}

function closeResumableChatRun(run: ResumableChatRun, error?: unknown): void {
  if (run.done) return
  run.done = true
  run.error = error
  for (const subscriber of run.subscribers) {
    if (error) subscriber.error(error)
    else subscriber.close()
  }
  run.subscribers.clear()
}

async function waitForResumableChatRun(runs: Map<string, ResumableChatRun>, key: string, signal: AbortSignal): Promise<ResumableChatRun | undefined> {
  for (let attempt = 0; attempt < 30 && !signal.aborted; attempt++) {
    const run = runs.get(key)
    if (run) return run
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, 100)
      function finish() {
        clearTimeout(timeout)
        signal.removeEventListener("abort", finish)
        resolve()
      }
      signal.addEventListener("abort", finish, { once: true })
    })
  }
}

async function waitForResumableChatSetup(setup: Promise<void>, signal: AbortSignal): Promise<boolean> {
  let settled = false
  void setup.then(() => {
    settled = true
  })
  for (let attempt = 0; attempt < 30 && !settled && !signal.aborted; attempt++) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(finish, 100)
      function finish() {
        clearTimeout(timeout)
        signal.removeEventListener("abort", finish)
        resolve()
      }
      signal.addEventListener("abort", finish, { once: true })
    })
  }
  return settled
}

async function waitForResumableChatReady(ready: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return await Promise.race([
    ready.then(() => true),
    new Promise<false>((resolve) => signal.addEventListener("abort", () => resolve(false), { once: true })),
  ])
}

function resumableChatKey(agentName: string, channelId: string | undefined, owner: string, chatId: string, messageId?: string): string {
  return JSON.stringify([agentName, channelId || "http", owner, chatId, ...(messageId ? [messageId] : [])])
}

export function createChannelChatRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChannelChatRouteHandlerOptions = {},
): AgentChannelChatRouteHandler {
  const routeOptions = resolveAgentChannelChatRouteHandlerOptions(agent, options)
  const resumableRuns = new Map<string, ResumableChatRun>()
  const latestResumableRuns = new Map<string, ResumableChatRun>()
  const resumableClaimSetups = new Map<string, Promise<void>>()
  const resumableClaimOwners = new Map<string, string>()
  const resumableClaimWaiters = new Map<string, number>()
  const resumableClaimWaiterResolves = new Map<string, Set<() => void>>()
  const resumableSessionBoundaryWrites = new Map<string, Promise<void>>()
  let resumableClaimWaiterCount = 0
  const resumableLookupOwners = new Map<string, number>()
  let resumableLookupCount = 0
  let resumableOwnerResolutionCount = 0
  const resumableOwnerBufferedBytes = new Map<string, number>()
  let resumableTotalBufferedBytes = 0
  type ResumableClaimSetup = { cancel: () => void, owner: string, promise: Promise<void>, sequence: number }
  const latestResumableClaimSetups = new Map<string, ResumableClaimSetup>()
  const resumableClaimSetupsByChat = new Map<string, Set<ResumableClaimSetup>>()
  const resumableCancellationTombstones = new Map<string, { cleanup: ReturnType<typeof setTimeout>, owner: string, sequence: number }>()
  let resumableRequestSequence = 0
  const resolveResumableOwner = async (
    resumable: AgentChannelChatRouteResumableOptions<unknown>,
    input: Parameters<typeof resumableChatOwner>[1],
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    if (signal.aborted) return undefined
    if (resumableOwnerResolutionCount >= resumableChatMaxTotalPendingOwnerResolutions) {
      throw createRouteError(429, "Resumable web chat has reached its owner resolution capacity. Try again later.")
    }
    resumableOwnerResolutionCount++
    let removeAbortListener = () => {}
    const owner = resumableChatOwner(resumable, input).finally(() => {
      removeAbortListener()
      resumableOwnerResolutionCount--
    })
    const aborted = new Promise<undefined>((resolve) => {
      const abort = () => resolve(undefined)
      signal.addEventListener("abort", abort, { once: true })
      removeAbortListener = () => signal.removeEventListener("abort", abort)
    })
    return await Promise.race([owner, aborted])
  }
  const withResumableSessionBoundaryWrite = async <T>(key: string, write: () => Promise<T>): Promise<T> => {
    const predecessor = resumableSessionBoundaryWrites.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    resumableSessionBoundaryWrites.set(key, current)
    await predecessor.catch(() => undefined)
    try {
      return await write()
    }
    finally {
      release()
      if (resumableSessionBoundaryWrites.get(key) === current) resumableSessionBoundaryWrites.delete(key)
    }
  }
  const setResumableCancellationTombstone = (key: string, owner: string, sequence: number): boolean => {
    const existing = resumableCancellationTombstones.get(key)
    if (existing && existing.sequence >= sequence) return true
    if (existing) clearTimeout(existing.cleanup)
    else if ([...resumableCancellationTombstones.values()].filter(tombstone => tombstone.owner === owner).length >= resumableChatMaxOwnerTombstones) return false
    else if (resumableCancellationTombstones.size >= resumableChatMaxTombstones) return false
    const tombstone = {
      cleanup: setTimeout(() => {
        if (resumableCancellationTombstones.get(key) === tombstone) resumableCancellationTombstones.delete(key)
      }, 600_000),
      owner,
      sequence,
    }
    tombstone.cleanup.unref?.()
    resumableCancellationTombstones.set(key, tombstone)
    return true
  }
  const releaseResumableChatRun = (run: ResumableChatRun): void => {
    if (run.released) return
    run.released = true
    if (run.cleanup) {
      clearTimeout(run.cleanup)
      run.cleanup = undefined
    }
    if (resumableRuns.get(run.invocationKey) === run) resumableRuns.delete(run.invocationKey)
    if (latestResumableRuns.get(run.latestKey) === run) latestResumableRuns.delete(run.latestKey)
    for (const release of run.replaySubscriberReleases) release()
    resumableTotalBufferedBytes -= run.bufferedBytes
    const ownerBufferedBytes = (resumableOwnerBufferedBytes.get(run.owner) || 0) - run.bufferedBytes
    if (ownerBufferedBytes) resumableOwnerBufferedBytes.set(run.owner, ownerBufferedBytes)
    else resumableOwnerBufferedBytes.delete(run.owner)
    run.chunks = []
    run.bufferedBytes = 0
  }
  const handler = async (request: Request, handlerOptions: AgentChannelChatRouteRequestOptions = {}) => {
    const requestSequence = ++resumableRequestSequence
    let releaseResumableClaim: (() => void) | undefined
    const resumable = routeOptions.resumable
    if (request.method !== "POST" && (!resumable || (request.method !== "GET" && request.method !== "DELETE"))) {
      return createJsonErrorResponse(405, "Agent chat route only accepts POST requests.")
    }

    try {
      if (request.method !== "POST") {
        const id = optionalBodyString(new URL(request.url).searchParams.get("id") || undefined, "id")
        if (!id) throw createRouteBodyError("Resumable agent chat requires an id query parameter.")
        const body = { id }
        const agentIdentity = routeAgentIdentity(handlerOptions)
        const agentName = agentIdentity?.name || "agent"
        const auth = await routeOptions.admission?.authenticate?.({
          agentName,
          body,
          event: handlerOptions.event,
          rawBody: "",
          request,
        })
        if (auth === false) throw createRouteError(401, "Agent chat route request was not admitted.")
        const owner = await resolveResumableOwner(resumable!, {
          agentName,
          auth,
          body,
          event: handlerOptions.event,
          rawBody: "",
          request,
        }, request.signal)
        if (!owner) return new Response(null, { status: 204 })
        const key = resumableChatKey(agentName, routeOptions.channelId, owner, id)
        if (request.method === "DELETE") {
          if (!setResumableCancellationTombstone(key, owner, requestSequence)) {
            throw createRouteError(429, "Resumable web chat has too many pending cancellations. Try again later.")
          }
        }
        let run = latestResumableRuns.get(key)
        if (request.method === "DELETE") {
          for (const activeRun of [...resumableRuns.values()]) {
            if (activeRun.latestKey !== key || activeRun.requestSequence > requestSequence) continue
            releaseResumableChatRun(activeRun)
            activeRun.cancelled = true
            closeResumableChatRun(activeRun)
            activeRun.abortController.abort("Cancelled by the web chat client.")
            void activeRun.reader?.cancel("Cancelled by the web chat client.").catch(() => undefined)
            activeRun.resolveReady()
          }
          for (const setup of resumableClaimSetupsByChat.get(key) || []) {
            if (setup.sequence <= requestSequence) setup.cancel()
          }
          return new Response(null, { status: 204 })
        }
        const pendingSetup = latestResumableClaimSetups.get(key)
        const waitsForSetup = Boolean(pendingSetup && (!run || pendingSetup.sequence > run.requestSequence))
        const waitsForReady = Boolean(run && !run.consume && !run.done && !run.setupError)
        if (waitsForSetup || waitsForReady || !run) {
          if ((resumableLookupOwners.get(owner) || 0) >= resumableChatMaxPendingLookups) {
            throw createRouteError(429, "Resumable web chat has too many pending lookups. Try again later.")
          }
          if (resumableLookupCount >= resumableChatMaxTotalPendingLookups) {
            throw createRouteError(429, "Resumable web chat has reached its pending lookup capacity. Try again later.")
          }
          resumableLookupOwners.set(owner, (resumableLookupOwners.get(owner) || 0) + 1)
          resumableLookupCount++
          try {
            if (waitsForSetup) {
              if (!await waitForResumableChatSetup(pendingSetup!.promise, request.signal)) return new Response(null, { status: 204 })
              run = latestResumableRuns.get(key)
            }
            run ||= await waitForResumableChatRun(latestResumableRuns, key, request.signal)
            if (run && !run.consume && !run.done && !run.setupError && !await waitForResumableChatReady(run.ready, request.signal)) {
              return new Response(null, { status: 204 })
            }
          }
          finally {
            const lookups = (resumableLookupOwners.get(owner) || 1) - 1
            if (lookups) resumableLookupOwners.set(owner, lookups)
            else resumableLookupOwners.delete(owner)
            resumableLookupCount--
          }
        }
        if (!run) return new Response(null, { status: 204 })
        await run.ready
        if (run.cancelled) return new Response(null, { status: 204 })
        if (run.setupError) throw run.setupError
        const waitUntil = await resolveRuntimeWaitUntil(handlerOptions.waitUntil)
        if (run.consume) waitUntil?.(run.consume)
        return resumableChatResponse(run)
      }

      const parsed = await parseAgentChannelChatRouteBody(request)
      const agentIdentity = routeAgentIdentity(handlerOptions)
      const agentName = agentIdentity?.name || "agent"
      const auth = await routeOptions.admission?.authenticate?.({ agentName, body: parsed.body, event: handlerOptions.event, rawBody: parsed.rawBody, request })
      if (auth === false) throw createRouteError(401, "Agent chat route request was not admitted.")
      const body = await parseAgentChannelChatRouteAdmissionBody(parsed.body, routeOptions.admission?.body)
      const resumes = Boolean(resumable && request.headers.get("x-vitehub-resumable") === "true")
      const resumableAbortController = resumes ? new AbortController() : undefined
      const context = createRuntimeContext(
        createRuntimeRequest(request, parsed.rawBody, resumableAbortController?.signal),
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
      const inputContext = { agentName, auth: auth as never, body, event: handlerOptions.event, input: trustedInput, rawBody: parsed.rawBody, request }
      const owner = resumes ? await resolveResumableOwner(resumable!, inputContext, request.signal) : undefined
      if (resumes && !owner) return new Response(null, { status: 204 })
      const admittedInput = mergeAgentChannelChatRouteInput(
        trustedInput,
        await routeOptions.admission?.context?.(inputContext),
      )
      let triggerInput = mergeAgentChannelChatRouteInput(
        admittedInput,
        await routeOptions.mapInput?.({ ...inputContext, input: admittedInput }),
      )
      const chatOptions = getChannelChatOptions(agent, routeOptions.channelId, getAgentChatOptions(agent)) || {}
      const chatId = optionalBodyString(body.id, "id") || "default"
      const latestKey = owner ? resumableChatKey(agentName, routeOptions.channelId, owner, chatId) : undefined
      const invocationKey = latestKey
        ? resumableChatKey(
            agentName,
            routeOptions.channelId,
            owner!,
            chatId,
            body.trigger === "regenerate-message" ? `regenerate:${randomToken()}` : triggerInput.run?.messageId || "default",
          )
        : undefined
      if (invocationKey) {
        while (true) {
          if ((resumableCancellationTombstones.get(latestKey!)?.sequence || 0) > requestSequence) {
            return new Response(null, { status: 204 })
          }
          const existingRun = resumableRuns.get(invocationKey)
          if (existingRun) {
            if (!existingRun.consume && !existingRun.done && !existingRun.setupError) {
              const ownerPendingClaims = [...resumableClaimOwners.values()].filter(claimOwner => claimOwner === owner).length
                + (resumableClaimWaiters.get(owner!) || 0)
              if (ownerPendingClaims >= resumableChatMaxPendingClaims || resumableClaimSetups.size + resumableClaimWaiterCount >= resumableChatMaxTotalPendingClaims) {
                throw createRouteError(429, "Resumable web chat has too many pending claims. Try again later.")
              }
              resumableClaimWaiters.set(owner!, (resumableClaimWaiters.get(owner!) || 0) + 1)
              resumableClaimWaiterCount++
              try {
                if (!await waitForResumableChatReady(existingRun.ready, request.signal)) return new Response(null, { status: 204 })
              }
              finally {
                const waiters = (resumableClaimWaiters.get(owner!) || 1) - 1
                if (waiters) resumableClaimWaiters.set(owner!, waiters)
                else resumableClaimWaiters.delete(owner!)
                resumableClaimWaiterCount--
              }
            }
            if (existingRun.cancelled) return new Response(null, { status: 204 })
            if (existingRun.setupError) throw existingRun.setupError
            return resumableChatResponse(existingRun)
          }
          const pendingSetup = resumableClaimSetups.get(invocationKey)
          if (pendingSetup) {
            const ownerPendingClaims = [...resumableClaimOwners.values()].filter(claimOwner => claimOwner === owner).length
              + (resumableClaimWaiters.get(owner!) || 0)
            if (ownerPendingClaims >= resumableChatMaxPendingClaims) {
              throw createRouteError(429, "Resumable web chat has too many pending claims. Try again later.")
            }
            if (resumableClaimSetups.size + resumableClaimWaiterCount >= resumableChatMaxTotalPendingClaims) {
              throw createRouteError(429, "Resumable web chat has reached its pending claim capacity. Try again later.")
            }
            resumableClaimWaiters.set(owner!, (resumableClaimWaiters.get(owner!) || 0) + 1)
            resumableClaimWaiterCount++
            try {
              await new Promise<void>((resolve) => {
                const waiters = resumableClaimWaiterResolves.get(invocationKey) || new Set<() => void>()
                resumableClaimWaiterResolves.set(invocationKey, waiters)
                const finish = () => {
                  request.signal.removeEventListener("abort", finish)
                  waiters.delete(finish)
                  if (!waiters.size && resumableClaimWaiterResolves.get(invocationKey) === waiters) {
                    resumableClaimWaiterResolves.delete(invocationKey)
                  }
                  resolve()
                }
                waiters.add(finish)
                if (request.signal.aborted) finish()
                else request.signal.addEventListener("abort", finish, { once: true })
              })
              if (request.signal.aborted) return new Response(null, { status: 204 })
            }
            finally {
              const waiters = (resumableClaimWaiters.get(owner!) || 1) - 1
              if (waiters) resumableClaimWaiters.set(owner!, waiters)
              else resumableClaimWaiters.delete(owner!)
              resumableClaimWaiterCount--
            }
            continue
          }
          let resolveSetup!: () => void
          const setup = new Promise<void>((resolve) => {
            resolveSetup = resolve
          })
          const ownerPendingClaims = [...resumableClaimOwners.values()].filter(claimOwner => claimOwner === owner).length
            + (resumableClaimWaiters.get(owner!) || 0)
          if (ownerPendingClaims >= resumableChatMaxPendingClaims) {
            throw createRouteError(429, "Resumable web chat has too many pending claims. Try again later.")
          }
          if (resumableClaimSetups.size + resumableClaimWaiterCount >= resumableChatMaxTotalPendingClaims) {
            throw createRouteError(429, "Resumable web chat has reached its pending claim capacity. Try again later.")
          }
          resumableClaimSetups.set(invocationKey, setup)
          resumableClaimOwners.set(invocationKey, owner!)
          let claimSettled = false
          const settleResumableClaim = () => {
            const waiters = resumableClaimWaiterResolves.get(invocationKey)
            resumableClaimWaiterResolves.delete(invocationKey)
            for (const resolve of waiters || []) resolve()
            if (claimSettled) return
            claimSettled = true
            const chatSetups = resumableClaimSetupsByChat.get(latestKey!)
            chatSetups?.delete(claimSetup)
            if (!chatSetups?.size) resumableClaimSetupsByChat.delete(latestKey!)
            if (latestResumableClaimSetups.get(latestKey!) === claimSetup) latestResumableClaimSetups.delete(latestKey!)
            resolveSetup()
          }
          releaseResumableClaim = () => {
            settleResumableClaim()
            if (resumableClaimSetups.get(invocationKey) === setup) {
              resumableClaimSetups.delete(invocationKey)
              resumableClaimOwners.delete(invocationKey)
            }
            releaseResumableClaim = undefined
          }
          const claimSetup: ResumableClaimSetup = {
            cancel() {
              resumableAbortController?.abort("Cancelled by the web chat client.")
              settleResumableClaim()
            },
            owner: owner!,
            promise: setup,
            sequence: requestSequence,
          }
          const chatSetups = resumableClaimSetupsByChat.get(latestKey!) || new Set<ResumableClaimSetup>()
          resumableClaimSetupsByChat.set(latestKey!, chatSetups)
          chatSetups.add(claimSetup)
          const latestSetup = latestResumableClaimSetups.get(latestKey!)
          if (!latestSetup || latestSetup.sequence < requestSequence) {
            latestResumableClaimSetups.set(latestKey!, claimSetup)
          }
          break
        }
      }
      const invokerInput = createChatMessageTriggerInput(chatOptions, triggerInput).input
      const invoker = await resolveAgentInvoker(
        (agent as AgentDefinition<ViteAgentRouteRuntimeConfig> | undefined)?.invoker,
        context,
        createAgentInvocationContextStore(invokerInput.context),
        invokerInput,
        triggerInput.run,
      )
      triggerInput = {
        ...withResolvedAgentInvokerInput(triggerInput as never, invoker) as AgentChatMessageTriggerInput,
        invoker,
      }
      const sessionId = triggerInput.run?.threadId ?? triggerInput.run?.runId
      let selectedSessionId = resolveChatSessionId(triggerInput.messages, chatOptions.sessions, triggerInput.session)
      const registration = {
        channelId: routeOptions.channelId || "http",
        id: routeOptions.channelId || "http",
        provider: routeOptions.origin || "http",
      }
      const resumableRequestCancelled = () => Boolean(
        resumableAbortController?.signal.aborted
        || (latestKey && (resumableCancellationTombstones.get(latestKey)?.sequence || 0) > requestSequence),
      )
      if (resumableRequestCancelled()) {
        releaseResumableClaim?.()
        return new Response(null, { status: 204 })
      }
      const { state } = await resolveChatState(chatOptions, context, registration, handlerOptions)
      await state.connect()
      const sessionOptions = chatOptions.sessions
      let approvalTtlMs = agentChatApprovalTtlMs
      let cancelledDuringSessionBoundary = false
      let refreshSessionBoundary: { key: string, value: string } | undefined
      const manualSessions = sessionOptions === true
        || Boolean(sessionOptions && (sessionOptions.strategy === "manual" || sessionOptions.strategy === "hybrid" || (!sessionOptions.strategy && !sessionOptions.idleTimeoutMs)))
      if (sessionId && manualSessions) {
        const manualId = resolveChatSessionBaseId(triggerInput.messages, chatOptions.sessions, triggerInput.session) || "default"
        const boundaryKey = agentChatSessionBoundaryKey(invoker.id, sessionId, manualId)
        approvalTtlMs = sessionOptions && sessionOptions !== true && sessionOptions.strategy === "hybrid" && sessionOptions.idleTimeoutMs
          ? Math.min(agentChatApprovalTtlMs, sessionOptions.idleTimeoutMs)
          : agentChatApprovalTtlMs
        if (triggerInput.session?.action === "new") {
          selectedSessionId = `${manualId}:manual:${randomToken()}`
          await withResumableSessionBoundaryWrite(boundaryKey, async () => {
            if (resumableRequestCancelled()) {
              cancelledDuringSessionBoundary = true
              return
            }
            const previous = await state.get<string>(boundaryKey)
            await state.set(boundaryKey, selectedSessionId!, approvalTtlMs)
            if (!resumableRequestCancelled()) return
            if (await state.get<string>(boundaryKey) === selectedSessionId) {
              if (previous) await state.set(boundaryKey, previous, approvalTtlMs)
              else await state.delete(boundaryKey)
            }
            cancelledDuringSessionBoundary = true
          })
        }
        else {
          await withResumableSessionBoundaryWrite(boundaryKey, async () => {
            if (resumableRequestCancelled()) {
              cancelledDuringSessionBoundary = true
              return
            }
            const previous = await state.get<string>(boundaryKey)
            selectedSessionId = previous || selectedSessionId
            if (previous && resumes) refreshSessionBoundary = { key: boundaryKey, value: previous }
            else if (selectedSessionId) await state.set(boundaryKey, selectedSessionId, approvalTtlMs)
            if (!resumableRequestCancelled()) return
            if (!previous && selectedSessionId && await state.get<string>(boundaryKey) === selectedSessionId) {
              await state.delete(boundaryKey)
            }
            cancelledDuringSessionBoundary = true
          })
        }
      }
      const approvalSessionId = sessionId && selectedSessionId
        ? `${sessionId}:chat-session:${selectedSessionId}`
        : sessionId
      if (cancelledDuringSessionBoundary || resumableRequestCancelled()) {
        releaseResumableClaim?.()
        return new Response(null, { status: 204 })
      }
      if (approvalSessionId) {
        const persistApprovedTools = invoker.kind !== "anonymous"
        if (!persistApprovedTools && triggerInput.messages.some(message => message.parts?.some(part => uiApprovalPart(part)?.record.state === "approval-responded"))) {
          throw createRouteBodyError("Agent chat approval responses require an authenticated invoker.")
        }
        const authorized = await authorizeAgentChatApprovals(state, invoker.id, approvalSessionId, triggerInput.messages, persistApprovedTools, approvalTtlMs)
        const approvedTools = persistApprovedTools
          ? await state.get<string[]>(agentChatApprovedToolsKey(invoker.id, approvalSessionId))
          : authorized.approvedTools
        triggerInput = {
          ...triggerInput,
          context: {
            ...triggerInput.context,
            ...(approvedTools?.length ? { "vitehub.eve.approvedTools": approvedTools } : {}),
          },
          messages: authorized.messages,
        }
      }
      let resumableRun: ResumableChatRun | undefined
      if (invocationKey && latestKey && resumable) {
        if ((resumableCancellationTombstones.get(latestKey)?.sequence || 0) > requestSequence) {
          releaseResumableClaim?.()
          return new Response(null, { status: 204 })
        }
        const ownerRuns = () => [...resumableRuns.values()].filter(run => run.owner === owner)
        if (ownerRuns().length >= resumableChatMaxRuns) {
          for (const retainedRun of resumableRuns.values()) {
            if (!retainedRun.done || retainedRun.owner !== owner) continue
            releaseResumableChatRun(retainedRun)
            break
          }
        }
        if (ownerRuns().length >= resumableChatMaxRuns) {
          throw createRouteError(429, "Resumable web chat has too many active runs. Try again later.")
        }
        if (resumableRuns.size >= resumableChatMaxTotalRuns) {
          for (const retainedRun of resumableRuns.values()) {
            if (!retainedRun.done) continue
            releaseResumableChatRun(retainedRun)
            break
          }
        }
        if (resumableRuns.size >= resumableChatMaxTotalRuns) {
          throw createRouteError(429, "Resumable web chat has reached its process capacity. Try again later.")
        }
        const resumableInvocationKey = invocationKey
        const resumableLatestKey = latestKey
        let resolveReady!: () => void
        const ready = new Promise<void>((resolve) => {
          resolveReady = resolve
        })
        resumableRun = {
          abortController: resumableAbortController!,
          bufferedBytes: 0,
          cancelled: false,
          chunks: [],
          done: false,
          headers: undefined,
          invocationKey: resumableInvocationKey,
          latestKey: resumableLatestKey,
          owner: owner!,
          ready,
          released: false,
          requestSequence,
          replaySubscribers: 0,
          replaySubscriberReleases: new Set(),
          resolveReady,
          status: 200,
          statusText: "",
          subscribers: new Set(),
        }
        resumableRuns.set(resumableInvocationKey, resumableRun)
        const latestRun = latestResumableRuns.get(resumableLatestKey)
        if (!latestRun || latestRun.requestSequence < requestSequence) latestResumableRuns.set(resumableLatestKey, resumableRun)
        releaseResumableClaim?.()

        try {
          let result = await runWithRuntimeCloudflareEnv(context, async () => await streamAgentTrigger(agent as never, context as never, "chat.message", triggerInput, {
            output: "ui-message-stream",
          }))
          if (refreshSessionBoundary) {
            await withResumableSessionBoundaryWrite(refreshSessionBoundary.key, async () => {
              if (await state.get<string>(refreshSessionBoundary!.key) === refreshSessionBoundary!.value) {
                await state.set(refreshSessionBoundary!.key, refreshSessionBoundary!.value, approvalTtlMs)
              }
            })
          }
          if (approvalSessionId) result = trackAgentChatApprovals(result, state, invoker.id, approvalSessionId, approvalTtlMs)
          const response = normalizeResumableChatStreamResponse(await toAgentChatFetchResponse(result), triggerInput.run?.runId || resumableInvocationKey)
          if (!response.body) throw new Error("[vitehub] Resumable web chat requires a stream response.")
          if (resumableRun.done || resumableRun.abortController.signal.aborted) {
            await response.body.cancel("Cancelled by the web chat client.").catch(() => undefined)
            return new Response(null, { status: 204 })
          }

          const headers = new Headers(response.headers)
          headers.set("x-vitehub-run-id", triggerInput.run?.runId || "")
          headers.delete("content-length")
          resumableRun.headers = headers
          resumableRun.status = response.status
          resumableRun.statusText = response.statusText
          resumableRun.reader = response.body.getReader()
          resumableRun.consume = (async () => {
            try {
              while (!resumableRun.done) {
                const chunk = await resumableRun.reader!.read()
                if (chunk.done) break
                const value = chunk.value.slice()
                resumableRun.bufferedBytes += value.byteLength
                resumableTotalBufferedBytes += value.byteLength
                let ownerBufferedBytes = (resumableOwnerBufferedBytes.get(resumableRun.owner) || 0) + value.byteLength
                resumableOwnerBufferedBytes.set(resumableRun.owner, ownerBufferedBytes)
                if (ownerBufferedBytes > resumableChatMaxOwnerBufferedBytes) {
                  for (const retainedRun of resumableRuns.values()) {
                    if (retainedRun === resumableRun || !retainedRun.done || retainedRun.owner !== resumableRun.owner) continue
                    ownerBufferedBytes -= retainedRun.bufferedBytes
                    releaseResumableChatRun(retainedRun)
                    if (ownerBufferedBytes <= resumableChatMaxOwnerBufferedBytes) break
                  }
                }
                if (resumableTotalBufferedBytes > resumableChatMaxTotalBufferedBytes) {
                  for (const retainedRun of resumableRuns.values()) {
                    if (retainedRun === resumableRun || !retainedRun.done) continue
                    releaseResumableChatRun(retainedRun)
                    if (resumableTotalBufferedBytes <= resumableChatMaxTotalBufferedBytes) break
                  }
                }
                if (resumableRun.bufferedBytes > resumableChatMaxBufferedBytes || ownerBufferedBytes > resumableChatMaxOwnerBufferedBytes || resumableTotalBufferedBytes > resumableChatMaxTotalBufferedBytes) {
                  releaseResumableChatRun(resumableRun)
                  const error = new Error("[vitehub] Resumable web chat exceeded the retained replay limit.")
                  closeResumableChatRun(resumableRun, error)
                  await resumableRun.reader!.cancel(error).catch(() => undefined)
                  break
                }
                resumableRun.chunks.push(value)
                for (const subscriber of resumableRun.subscribers) subscriber.enqueue(value)
              }
              closeResumableChatRun(resumableRun)
            }
            catch (error) {
              closeResumableChatRun(resumableRun, resumableChatError(error))
            }
            finally {
              const retainedRun = resumableRun!
              if (!retainedRun.released) {
                retainedRun.cleanup = setTimeout(() => releaseResumableChatRun(retainedRun), 600_000)
                retainedRun.cleanup.unref?.()
              }
            }
          })()
          resumableRun.resolveReady()
          context.waitUntil(resumableRun.consume)
          return resumableChatResponse(resumableRun)
        }
        catch (error) {
          if (resumableRun.cancelled) {
            resumableRun.resolveReady()
            return new Response(null, { status: 204 })
          }
          resumableRun.setupError = resumableChatError(error)
          resumableRun.resolveReady()
          resumableRuns.delete(resumableInvocationKey)
          if (latestResumableRuns.get(resumableLatestKey) === resumableRun) latestResumableRuns.delete(resumableLatestKey)
          throw error
        }
      }

      let result = await runWithRuntimeCloudflareEnv(context, async () => await streamAgentTrigger(agent as never, context as never, "chat.message", triggerInput, {
        output: "ui-message-stream",
      }))
      if (approvalSessionId) result = trackAgentChatApprovals(result, state, invoker.id, approvalSessionId, approvalTtlMs)
      return await toAgentChatFetchResponse(result)
    }
    catch (error) {
      releaseResumableClaim?.()
      return agentChatFetchErrorResponse(error)
    }
  }
  return Object.assign(handler, {
    inspect(): AgentChannelChatRouteInspection {
      let activeRuns = 0
      let liveSubscribers = 0
      for (const run of resumableRuns.values()) {
        if (!run.done) activeRuns++
        liveSubscribers += run.subscribers.size + run.replaySubscribers
      }
      return {
        activeRuns,
        bufferedBytes: resumableTotalBufferedBytes,
        liveSubscribers,
        maxBufferedBytesPerOwner: resumableChatMaxOwnerBufferedBytes,
        maxPendingCancellationsPerOwner: resumableChatMaxOwnerTombstones,
        maxPendingClaimsPerOwner: resumableChatMaxPendingClaims,
        maxPendingLookupsPerOwner: resumableChatMaxPendingLookups,
        maxTotalBufferedBytes: resumableChatMaxTotalBufferedBytes,
        maxTotalPendingCancellations: resumableChatMaxTombstones,
        maxTotalPendingClaims: resumableChatMaxTotalPendingClaims,
        maxTotalPendingLookups: resumableChatMaxTotalPendingLookups,
        maxTotalPendingOwnerResolutions: resumableChatMaxTotalPendingOwnerResolutions,
        maxRunsPerOwner: resumableChatMaxRuns,
        maxSubscribersPerRun: resumableChatMaxSubscribers,
        maxTotalRuns: resumableChatMaxTotalRuns,
        pendingCancellations: resumableCancellationTombstones.size,
        pendingClaims: resumableClaimSetups.size + resumableClaimWaiterCount,
        pendingLookups: resumableLookupCount,
        pendingOwnerResolutions: resumableOwnerResolutionCount,
        retainedRuns: resumableRuns.size - activeRuns,
      }
    },
  })
}

export function createChannelWebhookRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): AgentChannelWebhookRouteHandler {
  const queueScopes = new Map<string, { backendId: string, options: AgentChannelWebhookRouteOptions, scope: string, state: AgentWebhookQueueStateAdapter }>()
  const queueStates = new Map<AgentWebhookQueueStateAdapter, Map<string, string> | undefined>()
  const drainingScopes = new Set<string>()
  const pendingDrainScopes = new Set<string>()
  const retryTimers = new Map<string, { at: number, resolve: () => void, timer: ReturnType<typeof setTimeout> }>()
  const activeDeliveries = new Map<Promise<number | undefined>, { controller: AbortController, scope: string }>()
  const inFlightDrains = new Set<Promise<void>>()
  const activeInvocationScope = {}
  let queueStopped = false
  let drainQueue: (scope: string) => Promise<void>

  const scheduleQueueDrain = (queueId: string, at: number, waitUntil?: AgentWaitUntil) => {
    const existing = retryTimers.get(queueId)
    if (existing && existing.at <= at) return
    if (existing) {
      clearTimeout(existing.timer)
      existing.resolve()
    }
    let resolveScheduled!: () => void
    const scheduled = new Promise<void>(resolve => {
      resolveScheduled = resolve
    })
    const timer = setTimeout(() => {
      retryTimers.delete(queueId)
      void drainQueue(queueId).finally(resolveScheduled)
    }, Math.max(0, at - Date.now()))
    timer.unref?.()
    retryTimers.set(queueId, { at, resolve: resolveScheduled, timer })
    waitUntil?.(scheduled)
  }

  const drainQueueOnce = async (queueId: string) => {
    const queue = queueScopes.get(queueId)
    if (queueStopped || !queue) return
    if (drainingScopes.has(queueId)) {
      pendingDrainScopes.add(queueId)
      return
    }
    drainingScopes.add(queueId)
    try {
      const waitUntil = await resolveRuntimeWaitUntil(queue.options.waitUntil)
      while (!queueStopped) {
        const delivery = await queue.state.claimWebhookDelivery(queue.scope)
        if (!delivery) {
          if (![...activeDeliveries.values()].some(active => active.scope === queueId)) {
            scheduleQueueDrain(queueId, Date.now() + defaultWebhookQueueRetryMs)
          }
          break
        }
        if (queueStopped) {
          await queue.state.retryWebhookDelivery(queue.scope, delivery.deliveryId, delivery.leaseToken, Date.now()).catch(() => undefined)
          break
        }
        const controller = new AbortController()
        const task = executeQueuedWebhookDelivery(agent, queue.state, activeInvocationScope, queue.backendId, delivery, queue.options, controller.signal)
        activeDeliveries.set(task, { controller, scope: queueId })
        waitUntil?.(task)
        void task.then((retryAt) => {
          for (const registeredQueueId of queueScopes.keys()) {
            if (registeredQueueId !== queueId) void drainQueue(registeredQueueId)
          }
          if (retryAt === undefined || retryAt <= Date.now()) void drainQueue(queueId)
          else scheduleQueueDrain(queueId, retryAt, waitUntil)
        }).catch((error) => {
          console.error(`[vitehub] Queued webhook delivery "${delivery.deliveryId}" stopped unexpectedly.`, error)
          scheduleQueueDrain(queueId, Date.now() + defaultWebhookQueueRetryMs, waitUntil)
        }).finally(() => {
          activeDeliveries.delete(task)
        })
      }
    }
    catch (error) {
      console.error("[vitehub] Webhook queue drain failed and will be retried.", error)
      scheduleQueueDrain(queueId, Date.now() + defaultWebhookQueueRetryMs, await resolveRuntimeWaitUntil(queue.options.waitUntil))
    }
    finally {
      drainingScopes.delete(queueId)
      if (pendingDrainScopes.delete(queueId)) void drainQueue(queueId)
    }
  }

  drainQueue = (queueId) => {
    const task = drainQueueOnce(queueId)
    inFlightDrains.add(task)
    void task.finally(() => inFlightDrains.delete(task))
    return task
  }

  const registerQueue = async (backendId: string, scope: string, state: StateAdapter, options: AgentChannelWebhookRouteOptions) => {
    if (!hasAgentWebhookQueue(state)) return false
    if (!queueStates.has(state)) queueStates.set(state, new Map())
    queueStates.get(state)?.set(scope, backendId)
    const queueId = `${backendId}:${scope}`
    queueScopes.set(queueId, { backendId, options, scope, state })
    const task = drainQueue(queueId)
    const waitUntil = await resolveRuntimeWaitUntil(options.waitUntil)
    waitUntil?.(task)
    return true
  }

  const handler: AgentChannelWebhookRouteHandler = async (request, webhook, handlerOptions = {}) => {
    const webhookStartedAt = Date.now()
    if (request.method !== "HEAD" && request.method !== "POST") {
      return createJsonErrorResponse(405, "Agent webhook route only accepts HEAD and POST requests.")
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
    // Cloudflare cancels waitUntil after 30 seconds, so the final two seconds stay available for cleanup and fallback delivery.
    const maximumInvocationDeadline = context.runtime === "cloudflare-agents" && handlerOptions.waitUntil
      ? webhookStartedAt + cloudflareChatInvocationTimeoutMs
      : undefined
    return await runWithRuntimeCloudflareEnv(context, async () => {
      const match = await findAgentWebhookRegistration(agent, context, request, webhookId)
      if (!match) {
        return createJsonErrorResponse(404, "Unknown ViteHub agent webhook.")
      }

      const { registration, trigger } = match
      if (request.method === "HEAD") {
        return new Response(null, {
          headers: {
            "cache-control": "no-store",
            [agentChannelSyncProviderHeader]: registration.provider,
          },
          status: 204,
        })
      }
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
          if (invocation.webhook?.busy === "steer" && (invocation.webhook.concurrencyKey === undefined || invocation.webhook.concurrencyLimit === undefined)) {
            return createJsonErrorResponse(500, 'Webhook busy: "steer" requires concurrencyKey and concurrencyLimit.')
          }
          if ((invocation.webhook?.concurrencyKey !== undefined || invocation.webhook?.concurrencyLimit !== undefined) && await hasActiveWorkflowRuntime(agent, context)) {
            return createJsonErrorResponse(503, "Webhook concurrency ownership requires inline Agent execution.")
          }
          const webhookState = invocation.webhook
            ? await resolveAgentWebhookState(context, registration, handlerOptions)
            : undefined
          if (invocation.webhook && !webhookState) {
            return createJsonErrorResponse(503, "Durable Agent state is required for webhook delivery ownership.")
          }
          if (invocation.webhook?.concurrencyLimit !== undefined && webhookState) {
            const { concurrencyKey, deliveryId } = invocation.webhook
            if (!deliveryId.trim()) {
              return createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty deliveryId.")
            }
            if (concurrencyKey !== undefined && !concurrencyKey.trim()) {
              return createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty concurrencyKey when configured.")
            }
            if (invocation.webhook.busy === "steer" && invocation.webhook.rehydrate) {
              return createJsonErrorResponse(500, "Webhook delivery ownership cannot combine busy steering with rehydration.")
            }
            const concurrencyLimit = positiveWebhookConcurrencyLimit(invocation.webhook.concurrencyLimit)!
            if (!hasAgentWebhookQueue(webhookState.state)) {
              return createJsonErrorResponse(503, "Persistent webhook concurrency requires a queue-capable Agent state provider.")
            }
            const backendId = await resolveWebhookStateBackendId(webhookState.state)
            const persistedInvocation = persistedWebhookInvocation(invocation as unknown as { input: Record<string, unknown>, run?: unknown })
            const delivery = persistedWebhookRequest(
              deliveryId,
              request,
              await request.clone().text(),
              webhookId,
              { ...invocation.webhook, concurrencyLimit },
              webhookState.keyPrefix,
              routeAgentIdentity(handlerOptions)?.name || "agent",
              !invocation.webhook.rehydrate && isJsonSafe(persistedInvocation) ? persistedInvocation : undefined,
              Boolean(invocation.webhook.rehydrate),
            )
            if (invocation.webhook.busy === "steer") {
              const webhookQueueState = webhookState.state
              const outcome = await steerQueuedWebhookDelivery(webhookQueueState, activeInvocationScope, backendId, delivery, invocation.input, waitUntil, async (reserved) => {
                if (reserved) return Response.json({ accepted: true, duplicate: false, ok: true, queued: true })
                const queued = await webhookQueueState.enqueueWebhookDelivery(delivery)
                return Response.json({ accepted: queued, duplicate: !queued, ok: true, queued })
              })
              if (outcome) {
                if (outcome.queued) registerQueue(backendId, webhookState.keyPrefix, webhookQueueState, handlerOptions)
                return outcome.response
              }
            }
            const queued = await webhookState.state.enqueueWebhookDelivery(delivery)
            await registerQueue(backendId, webhookState.keyPrefix, webhookState.state, handlerOptions)
            return Response.json({ accepted: queued, duplicate: !queued, ok: true, queued })
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

      const webhookDeadlineAbort = maximumInvocationDeadline === undefined ? undefined : new AbortController()
      const chatWebhookTask = (async () => {
        const baseChatOptions = getAgentChatOptions(agent)
        const adapters = await resolveChatAdapters(baseChatOptions, context)
        webhookDeadlineAbort?.signal.throwIfAborted()
        const adapterName = resolveChatAdapterName(adapters, registration)
        const adapter = adapterName ? adapters[adapterName] : undefined
        if (!adapter) {
          return createJsonErrorResponse(500, `Agent chat webhook "${webhookId}" does not have a matching chat adapter.`)
        }

        try {
          const chatOptions = getChannelChatOptions(agent, registration.channelId, baseChatOptions)
          const handler = await createChatWebhookHandler(agent, context, registration, adapterName!, adapter, chatOptions, handlerOptions, maximumInvocationDeadline)
          webhookDeadlineAbort?.signal.throwIfAborted()
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
      })()
      return await enforceChatInvocationTimeout(
        chatWebhookTask,
        maximumInvocationDeadline === undefined ? undefined : Math.max(0, maximumInvocationDeadline - Date.now()),
        webhookDeadlineAbort,
      )
    })
  }
  handler.resume = (handlerOptions = {}) => {
    let stopped = false
    let discovered = false
    let discovering: Promise<void> | undefined
    let discoveringScopes: Promise<void> | undefined
    queueStopped = false
    const agentScopePrefix = `webhook:${webhookScopeComponent(routeAgentIdentity(handlerOptions)?.name || "agent")}:`
    const discoverScopes = async () => {
      if (stopped || discoveringScopes) return
      discoveringScopes = (async () => {
        for (const [state, knownScopes] of queueStates) {
          const persistedScopes = new Set(await state.webhookDeliveryScopes())
          if (knownScopes) {
            for (const [scope, backendId] of knownScopes) {
              if (persistedScopes.has(scope)) await registerQueue(backendId, scope, state, handlerOptions)
            }
          }
          else {
            const backendId = await resolveWebhookStateBackendId(state)
            for (const scope of persistedScopes) {
              if (scope.startsWith(agentScopePrefix)) await registerQueue(backendId, scope, state, handlerOptions)
            }
          }
        }
      })()
        .catch(error => console.error("[vitehub] Webhook queue scope discovery failed and will be retried.", error))
        .finally(() => {
          discoveringScopes = undefined
        })
      await discoveringScopes
    }
    const discover = async () => {
      if (stopped || discovered || discovering) return
      discovering = (async () => {
        const request = new Request("http://vitehub.local/_vitehub/webhook-queue")
        const context = createRuntimeContext(
          request,
          undefined,
          await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
          handlerOptions.cloudflare,
          handlerOptions.runtime,
          handlerOptions.capabilities,
          routeAgentIdentity(handlerOptions),
        )
        if (handlerOptions.webhookState && !stateResolverOwnsScope(handlerOptions.webhookState)) {
          const state = await resolveMaybe(handlerOptions.webhookState, context as never)
          if (state) {
            await state.connect()
            if (hasAgentWebhookQueue(state)) {
              queueStates.set(state, undefined)
            }
          }
        }
        for (const { registration } of await agentWebhookRegistrations(agent, context)) {
          if (stopped) return
          const webhookState = await resolveAgentWebhookState(context, registration, handlerOptions)
          if (webhookState && hasAgentWebhookQueue(webhookState.state)) {
            const backendId = await resolveWebhookStateBackendId(webhookState.state)
            await registerQueue(backendId, webhookState.keyPrefix, webhookState.state, handlerOptions)
          }
        }
        await discoverScopes()
        discovered = true
      })()
        .catch(error => console.error("[vitehub] Webhook queue startup discovery failed and will be retried.", error))
        .finally(() => {
          discovering = undefined
        })
      await discovering
    }
    void discover()
    const timer = setInterval(() => {
      if (!stopped) {
        void discover()
        if (discovered) void discoverScopes()
        for (const scope of queueScopes.keys()) void drainQueue(scope)
      }
    }, defaultWebhookQueueRetryMs)
    timer.unref?.()
    return async () => {
      stopped = true
      queueStopped = true
      clearInterval(timer)
      for (const retryTimer of retryTimers.values()) {
        clearTimeout(retryTimer.timer)
        retryTimer.resolve()
      }
      retryTimers.clear()
      pendingDrainScopes.clear()
      for (const { controller } of activeDeliveries.values()) {
        controller.abort(new Error("[vitehub] Webhook queue stopped during Agent execution."))
      }
      await Promise.allSettled(inFlightDrains)
      await Promise.allSettled(activeDeliveries.keys())
    }
  }
  return handler
}

const telegramPollingChats = new WeakMap<object, Map<string, Promise<Chat>>>()

async function startChannelChat(chat: Chat): Promise<void> {
  const initialize = Reflect.get(chat, "initialize")
  if (typeof initialize !== "function") {
    throw new TypeError("[vitehub] The installed Chat SDK does not support starting listener-based Channels.")
  }
  await Reflect.apply(initialize, chat, [])
}

export function createTelegramPollingRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
): (request: Request, options?: AgentTelegramPollingRouteOptions) => Promise<Response> {
  return async (request, handlerOptions = {}) => {
    if (request.method !== "GET") {
      return createJsonErrorResponse(405, "Telegram polling route only accepts GET requests.")
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
      const channels = isRecord(agent.channels) ? agent.channels : {}
      const entries = Object.entries(channels)
        .filter((entry): entry is [string, AgentChannelDefinition] =>
          isRecord(entry[1])
          && entry[1].kind === "telegram"
          && entry[1].listener?.kind === "telegram-polling"
          && entry[1].messages !== false
          && entry[1].adapter !== undefined,
        )
      if (entries.length === 0) {
        return createJsonErrorResponse(500, "Telegram polling route requires a polling Telegram Channel.")
      }

      let chats = telegramPollingChats.get(agent as object)
      if (!chats) {
        chats = new Map()
        telegramPollingChats.set(agent as object, chats)
      }
      const chatOptions = getAgentChatOptions(agent)
      await Promise.all(entries.map(async ([channelId, channel]) => {
        let chat = chats!.get(channelId)
        if (!chat) {
          chat = (async () => {
            const adapter = await resolveMaybe(channel.adapter, context)
            if (!adapter) {
              throw new Error(`[vitehub] Telegram polling Channel "${channelId}" did not resolve a chat adapter.`)
            }
            const registration = {
              adapter: channelId,
              channelId,
              id: channelId,
              provider: "telegram",
            }
            const instance = await createChannelChat(
              agent,
              context,
              registration,
              channelId,
              adapter as Adapter,
              getChannelChatOptions(agent, channelId, chatOptions),
              handlerOptions,
            )
            await startChannelChat(instance)
            return instance
          })()
          chats!.set(channelId, chat)
          chat.catch(() => chats!.delete(channelId))
        }
        await chat
      }))
      return Response.json({ ok: true, polling: entries.length })
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

      const chats: Chat[] = []
      try {
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

          const registration = await resolveDiscordWebhookRegistration(agent, context, adapters, adapterName) || {
            adapter: adapterName,
            channelId: adapterName,
            id: adapterName,
            provider: "discord",
          }
          const chat = await createChannelChat(
            agent,
            context,
            registration,
            adapterName,
            adapter,
            getChannelChatOptions(agent, registration.channelId, chatOptions),
            handlerOptions,
          )
          await (chat as { initialize?: () => Promise<void> }).initialize?.()
          chats.push(chat)
          const webhookId = registration.id || adapterName
          const webhookUrl = typeof handlerOptions.webhookUrl === "function"
            ? handlerOptions.webhookUrl(webhookId)
            : handlerOptions.webhookUrl

          responsePromises.push(startGatewayListener.call(
            adapter,
            { waitUntil: context.waitUntil },
            handlerOptions.durationMs,
            handlerOptions.abortSignal,
            webhookUrl,
          ))
        }

        const responses = await Promise.all(responsePromises)
        if (!handlerOptions.webhookUrl) await context.flushWaitUntil?.()
        if (responses.length === 1) return responses[0]!
        const failed = responses.find(response => !response.ok)
        if (failed) return failed
        return Response.json({ gateways: responses.length, ok: true })
      }
      finally {
        if (!handlerOptions.webhookUrl) {
          await Promise.allSettled(chats.map(chat => chat.shutdown()))
        }
      }
    })
  }
}
