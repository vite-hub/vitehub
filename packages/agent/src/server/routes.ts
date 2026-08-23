import { parseStandardSchema } from "@vite-hub/internal/http-request"
import { runWithActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { createRuntimeWaitUntilController, resolveRuntimeContext } from "@vite-hub/runtime"
import { Chat, StreamingPlan, ThreadImpl, convertEmojiPlaceholders } from "chat"

import {
  portableAgentWorkflowInput,
  resolveAgentTriggerInvocation,
  resolveAgentTriggers,
  runAgent,
  runAgentInline,
  startAgentInvocation,
  streamAgent,
  streamAgentTrigger,
} from "../index.ts"
import { awaitAgentInvocationResult } from "../agent-invocation.ts"
import { hasTraceableStreamResult, isAsyncIterable, streamAgentOutputToEvents } from "../agent-output.ts"
import { toAgentPublicError } from "../agent-error.ts"
import { getAccessCapabilityOptions } from "../capabilities/access-metadata.ts"
import { assertChatDeliveryOptions, CHAT_FINISH_EXTENSION_CONTEXT_KEY, getChatCapabilityOptions, resolveChatErrorFallbackText } from "../chat-trigger.ts"
import {
  chatTriggerHistoryLimit,
  createChatMessageTriggerInput,
  resolveChatSessionBaseId,
  resolveChatSessionId,
  resolveChatTriggerHistory,
  uiMessagesToAgentMessages,
} from "../chat-message-input.ts"
import { normalizeCapabilities } from "../capability-runtime.ts"
import { deliveryArtifactAttachments } from "../delivery-artifacts.ts"
import { createAgentInvocationContextStore } from "../invocation-context.ts"
import { finalChannelOutputContextKey, hasOnlyPortableAgentWorkflowCapabilities, requireAgentWorkflowContextKey } from "../internal/final-channel-output.ts"
import { agentChannelHistoryHeader } from "../internal/channel-history.ts"
import { agentChannelSyncProviderHeader } from "../internal/channel-sync.ts"
import { agentOutputEventObserverContextKey } from "../internal/agent-output-events.ts"
import { attachmentStringBytes, isAttachmentData } from "../messages.ts"
import { hasResolvedAgentInvokerInput, resolveInputAgentInvoker, resolveAgentInvoker, withResolvedAgentInvokerInput } from "../invoker.ts"
import { createAgentRuntimeContext } from "../runtime/context.ts"
import { createAgentUIMessageStreamResponse } from "../stream-output.ts"
import {
  isResolvedAgentTriggerHandledInvocation,
  resolveAgentTriggerInvocation as resolveAgentTriggerInvocationWithResolvedContext,
  resolveAgentTriggerInvocationResult,
  verifyAgentWebhookRequest,
} from "../trigger-runtime.ts"
import { AgentHttpError, toHttpErrorResponse } from "../http-error.ts"
import { isWorkflowRun } from "../http-response.ts"
import { messageChannelStateContextKey } from "../internal/channels.ts"
import { requireAtomicAgentStateQueue } from "../internal/state-queue.ts"
import { isAmbiguousAgentWorkflowStartFailure } from "../internal/workflow-start.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"
import { portableWorkflowCapabilityOverrides } from "../internal/workflow-portability.ts"
import {
  isRuntimeBigInt,
  isRuntimeBoolean,
  isRuntimeFunction,
  isRuntimeNumber,
  isRuntimeObject,
  isRuntimeString,
  isRuntimeSymbol,
  isRuntimeUndefined,
} from "../internal/runtime-value.ts"
import { hasAgentWebhookQueue } from "../internal/webhook-queue.ts"
import { activeAgentInvocation, registerActiveAgentInvocation } from "../internal/agent-invocation-control.ts"
import {
  agentChannelDeliveryMessageIdentity,
  agentChannelDeliveryPayloadFingerprint,
  agentChannelDeliverySourceId,
  agentChannelDeliverySourceValue,
  agentChannelDeliveryTracker,
  agentChannelDeliveryWorkflowContextKey,
  bindAgentChannelDeliveryMessage,
  bindAgentChannelDeliveryPayload,
  detachAgentChannelDelivery,
  openAgentChannelDelivery,
  readAgentChannelDeliveries,
  resumeAgentChannelDelivery,
  resumeAgentChannelDeliveryMessage,
  resumeAgentChannelDeliveryPayload,
  setAgentChannelDeliveryWorkflowOwnershipResolver,
  setAgentChannelDeliveryWorkflowResolver,
  withAgentChannelDelivery,
} from "../internal/channel-delivery.ts"

import type { AgentChatMessageTriggerInput } from "../chat-trigger.ts"
import type { UIMessageLike } from "../chat-message-input.ts"
import type {
  AgentChatStateResolver,
  AgentCapabilityDefinition,
  AgentChannelDefinition,
  AgentChannelDeliveryEventInput,
  AgentChannelDeliveryInspection,
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
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatConfig,
  Lock,
  Message as ChatSdkMessage,
  MessageContext,
  QueueEntry,
  StateAdapter,
  Thread,
  WebhookOptions,
} from "chat"
import type { UIMessage } from "ai"
import type { AgentWebhookQueueDelivery, AgentWebhookQueueLease, AgentWebhookQueueStateAdapter } from "../internal/webhook-queue.ts"
import type { AgentChannelDeliveryTracker, AgentChannelDeliveryWorkflowBinding } from "../internal/channel-delivery.ts"

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

type AgentChannelDeliveryWorkflowStateResolver = (
  context: ViteAgentRouteRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
) => MaybePromise<Pick<AgentChannelWebhookRouteOptions, "state" | "webhookState">>

let agentChannelDeliveryWorkflowStateResolver: AgentChannelDeliveryWorkflowStateResolver | undefined

export function setAgentChannelDeliveryWorkflowStateResolver(resolver: AgentChannelDeliveryWorkflowStateResolver): void {
  agentChannelDeliveryWorkflowStateResolver = resolver
}

export interface AgentChannelWebhookRouteHandler {
  (request: Request, webhook?: string, options?: AgentChannelWebhookRouteOptions): Promise<Response>
  deliveries(request: Request, webhook?: string, options?: AgentChannelWebhookRouteOptions & { limit?: number }): Promise<AgentChannelDeliveryInspection[]>
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

export interface AgentChannelChatRouteHandler {
  (request: Request, options?: AgentChannelChatRouteRequestOptions): Promise<Response>
  deliveries(request: Request, options?: AgentChannelChatRouteRequestOptions & { limit?: number }): Promise<AgentChannelDeliveryInspection[]>
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
    validate: (
      input: unknown,
    ) =>
      | AgentChannelChatRouteStandardSchemaResultSuccess<T>
      | AgentChannelChatRouteStandardSchemaResultFailure
      | Promise<AgentChannelChatRouteStandardSchemaResultSuccess<T> | AgentChannelChatRouteStandardSchemaResultFailure>
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

export type AgentChannelChatRouteTrustedInputField = "meta" | "session" | "timeout" | "user"

export interface AgentChannelChatRouteContext<
  TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody,
  TAuth = unknown,
> extends AgentChannelChatRouteAdmissionContext<TBody> {
  auth: Exclude<TAuth, false>
  input: AgentChatMessageTriggerInput
}

export interface AgentChannelChatRouteMapInputContext<
  TBody extends AgentChannelChatRouteBody = AgentChannelChatRouteBody,
  TAuth = unknown,
> extends AgentChannelChatRouteContext<TBody, TAuth> {}

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

function createRouteBodyError(message: string): Error & { status?: number; statusCode?: number } {
  return createRouteError(400, message)
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => isRuntimeString(value) && value.length > 0)
}

function isReadableStreamLike(value: unknown): value is ReadableStream<unknown> {
  return isRecord(value) && isRuntimeFunction(value.getReader) && isRuntimeFunction(value.pipeThrough)
}

function isHeadersLike(value: unknown): value is Headers {
  return isRecord(value) && isRuntimeFunction(value.entries) && isRuntimeFunction(value.get)
}

function isResponseLike(value: unknown): value is Response & { body: ReadableStream<unknown> } {
  return (
    isRecord(value) && isReadableStreamLike(value.body) && isHeadersLike(value.headers) && isRuntimeNumber(value.status) && isRuntimeString(value.statusText)
  )
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

  return new Response(
    new ReadableStream<Uint8Array>({
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
        } catch (error) {
          controller.error(error)
        }
      },
      async cancel(reason) {
        await reader.cancel(reason)
      },
    }),
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    },
  )
}

function createJsonErrorResponse(status: number, message: string): Response {
  return Response.json(
    {
      error: true,
      status,
      statusText: message,
      message,
    },
    { status },
  )
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
  const result = available > suffix.length ? `${value.slice(0, available - suffix.length)}${suffix}` : "[Truncated]"
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
  if (isRuntimeString(value)) return serializeLogString(value, state)
  if (value === null || isRuntimeNumber(value) || isRuntimeBoolean(value) || isRuntimeUndefined(value)) return value
  if (isRuntimeBigInt(value) || isRuntimeSymbol(value) || isRuntimeFunction(value)) {
    return serializeLogString(String(value), state)
  }
  if (!isRuntimeObject(value)) return serializeLogString(String(value), state)
  if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`
  if (value instanceof Blob) return `[Blob ${value.size} bytes, ${value.type || "unknown type"}]`
  if (value instanceof Date) return value.toISOString()
  if (state.seen.has(value)) return "[Circular]"
  if (depth >= errorLogMaxDepth || state.nodes >= errorLogMaxNodes) return "[Truncated]"
  state.seen.add(value)
  state.nodes++

  if (Array.isArray(value)) {
    const output = value.slice(0, errorLogMaxProperties).map((item) => serializeErrorForLog(item, state, depth + 1))
    if (value.length > output.length) output.push(`[${value.length - output.length} items omitted]`)
    return output
  }

  const output: Record<string, unknown> = {}
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const source = value as Record<string, unknown>
  if (value instanceof Error) {
    output.message = serializeErrorForLog(value.message, state, depth + 1)
    output.name = serializeErrorForLog(value.name, state, depth + 1)
    if (value.stack) output.stack = serializeErrorForLog(value.stack, state, depth + 1)
  }
  const keys = Object.keys(value)
    .filter((key) => !(value instanceof Error && (key === "message" || key === "name" || key === "stack" || key === "cause")))
    .slice(0, errorLogMaxProperties)
  for (const key of keys) {
    const outputKey = key.length > 128 ? `${key.slice(0, 112)}… [key truncated]` : key
    try {
      output[outputKey] = serializeErrorForLog(source[key], state, depth + 1)
    } catch {
      output[outputKey] = "[Unserializable property]"
    }
  }
  if (Object.keys(value).length > keys.length) {
    output["[truncated]"] = `${Object.keys(value).length - keys.length} properties omitted`
  }
  if (value instanceof Error && "cause" in value && !isRuntimeUndefined(value.cause)) {
    output.cause = serializeErrorForLog(value.cause, state, depth + 1)
  }
  return output
}

function detectRuntime(): AgentRuntimeName {
  if ("Deno" in globalThis) return "deno"
  const runtimeProcess = globalThis.process
  const env = isRuntimeObject(runtimeProcess) ? runtimeProcess.env : undefined
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
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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

async function runWithRuntimeCloudflareEnv<T>(context: ViteAgentRouteRuntimeContext, callback: () => Promise<T>): Promise<T> {
  if (!context.cloudflare?.env) {
    return callback()
  }
  return await runWithActiveCloudflareEnv(context.cloudflare.env, callback)
}

async function resolveRuntimeWaitUntil(waitUntil: AgentWaitUntil | undefined): Promise<AgentWaitUntil | undefined> {
  if (detectRuntime() !== "vercel") return waitUntil
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const vercel = (await import(/* @vite-ignore */ vercelFunctionsPackage).catch(() => undefined)) as { waitUntil?: AgentWaitUntil } | undefined
  return vercel?.waitUntil || waitUntil
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isRuntimeObject(value) && value !== null
}

function isResolvableObject<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext>,
): value is { resolve: (context: TContext) => T | Promise<T> } {
  return isRecord(value) && isRuntimeFunction(value.resolve)
}

async function resolveMaybe<T, TContext extends AgentRuntimeContext>(
  value: MaybeResolvable<T, TContext> | undefined,
  context: TContext,
): Promise<T | undefined> {
  if (value === undefined) return undefined
  if (isRuntimeFunction(value)) {
    // SAFETY: This value retains the generic type recorded when the owning runtime entry was created.
    return await (value as (context: TContext) => T | Promise<T>)(context)
  }
  if (isResolvableObject<T, TContext>(value)) {
    return await value.resolve(context)
  }
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  return value as T
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
}

function getAgentCapabilities(agent: unknown): AgentCapabilityDefinition[] {
  if (!isRecord(agent)) return []
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const definition = agent as AgentDefinitionWithCapabilities
  const capabilities = definition.capabilities || definition.__vitehubWorkspaceAgentOptions?.capabilities
  return normalizeCapabilities(Array.isArray(capabilities) ? capabilities : undefined)
}

function getAgentChatOptions(agent: unknown): AgentChatOptions | undefined {
  if (!isRecord(agent)) return undefined
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const definition = agent as AgentDefinitionWithCapabilities
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  return getChatCapabilityOptions(getAgentCapabilities(agent)) || definition.chat
}

function getChannelChatOptions(agent: unknown, channelId: string | undefined, options: AgentChatOptions | undefined): AgentChatOptions | undefined {
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
  if (!channels.some((channel) => isRecord(channel) && channel.adapter && channel.messages !== false)) return true
  return channels.some((channel) => isRecord(channel) && isRecord(channel.messages) && channel.messages.stream === false)
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
  return isRuntimeString(registration.path) && normalizeWebhookPath(new URL(request.url).pathname) === normalizeWebhookPath(registration.path)
}

async function findAgentWebhookRegistration(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  request: Request,
  webhook?: string,
): Promise<AgentWebhookRegistrationMatch | undefined> {
  const registrations = await agentWebhookRegistrations(agent, context)
  const pathMatches = registrations.filter((match) => webhookRegistrationPathMatches(request, match.registration))
  if (pathMatches.length === 1) return pathMatches[0]
  if (pathMatches.length > 1) return undefined
  if (webhook === "" && registrations.length === 1) return registrations[0]
  if (!webhook) return undefined
  const directMatches = registrations.filter(
    ({ registration }) => registration.id === webhook || (registration.channelId === webhook && registration.id === registration.channelId),
  )
  if (directMatches.length === 1) return directMatches[0]
  if (directMatches.length > 1) return undefined
  const providerMatches = registrations.filter(({ registration }) => registration.provider === webhook)
  return providerMatches.length === 1 ? providerMatches[0] : undefined
}

async function agentWebhookRegistrations(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
): Promise<AgentWebhookRegistrationMatch[]> {
  // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  return Object.values(triggers).flatMap((trigger) =>
    (trigger.webhooks || []).map((registration) => ({
      registration,
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      trigger: trigger as ResolvedAgentTriggerDefinition<ViteAgentRouteRuntimeConfig>,
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    })),
  )
}

async function matchedWebhookRegistrationRequiresVerification(
  registration: AgentWebhookRegistrationDefinition,
  context: ViteAgentRouteRuntimeContext,
  requireConfiguredSecret: boolean,
): Promise<boolean> {
  if (registration.secretToken !== undefined) return (await resolveMaybe(registration.secretToken, context)) !== false
  return requireConfiguredSecret && registration.secretHeader !== undefined
}

function parseWebhookPayload(body: string): unknown {
  if (!body) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function requestHeaders(request: Request): Record<string, string> {
  return Object.fromEntries(request.headers.entries())
}

function webhookDeliverySourceId(request: Request, provider: string, payload: unknown): string {
  const header = request.headers.get("x-github-delivery") || request.headers.get("x-vitehub-delivery-id") || request.headers.get("idempotency-key")
  if (header) return header
  const source = agentChannelDeliverySourceId(provider, payload)
  if (source) return source
  return randomToken()
}

function channelDeliveryError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}

function logChannelDeliveryAliasFailure(delivery: AgentChannelDeliveryTracker, alias: "message" | "payload", error: unknown): void {
  console.error(
    JSON.stringify({
      scope: "vitehub.channel.delivery",
      event: "alias.failed",
      alias,
      deliveryId: delivery.delivery.id,
      provider: delivery.delivery.provider,
      sourceId: delivery.delivery.sourceId,
      error: channelDeliveryError(error),
    }),
  )
}

async function recordChannelDeliveryEvidence(delivery: AgentChannelDeliveryTracker, input: AgentChannelDeliveryEventInput): Promise<void> {
  try {
    await delivery.event(input)
  } catch {}
}

async function settleChannelDeliveryInvocation(
  delivery: AgentChannelDeliveryTracker,
  invocation: "completed" | "failed",
  terminal: "completed" | "failed" | "rejected",
  input: Omit<AgentChannelDeliveryEventInput, "type"> = {},
): Promise<void> {
  await recordChannelDeliveryEvidence(delivery, { ...input, type: `invocation.${invocation}` })
  await recordChannelDeliveryEvidence(delivery, { ...input, type: terminal })
}

async function terminalChannelDeliveryResponse(
  delivery: AgentChannelDeliveryTracker,
  response: Response,
  type: "completed" | "failed" | "rejected" = "rejected",
): Promise<Response> {
  await recordChannelDeliveryEvidence(delivery, { type })
  return response
}

async function observeHandledChannelDeliveryResponse(response: Response, delivery: AgentChannelDeliveryTracker): Promise<Response> {
  const terminalType = response.ok ? "completed" : response.status >= 500 ? "failed" : "rejected"
  if (!response.body) {
    await recordChannelDeliveryEvidence(delivery, { type: terminalType })
    return response
  }
  const reader = response.body.getReader()
  let finished = false
  const settle = async (type: "completed" | "failed" | "rejected", error?: unknown) => {
    if (finished) return
    finished = true
    await recordChannelDeliveryEvidence(delivery, {
      ...(error === undefined ? {} : { error: channelDeliveryError(error) }),
      type,
    })
  }
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            await settle(terminalType)
            controller.close()
          } else controller.enqueue(next.value)
        } catch (error) {
          await settle("failed", error)
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          await settle("failed", reason || new Error("Channel response stream was cancelled."))
        }
      },
    }),
    response,
  )
}

function logChannelListener(event: string, provider: string, listenerId: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ scope: "vitehub.channel.listener", event, provider, listenerId, ...extra }))
}

function observeChatThread(thread: Thread, delivery: AgentChannelDeliveryTracker): Thread {
  return new Proxy(thread, {
    get(target, property) {
      if (property === "post") {
        return async (...args: Parameters<Thread["post"]>) => {
          await recordChannelDeliveryEvidence(delivery, { type: "outbound.started" })
          try {
            const message = await target.post(...args)
            await recordChannelDeliveryEvidence(delivery, {
              // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
              messageId: agentChannelDeliverySourceValue((message as { id?: unknown }).id),
              type: "outbound.completed",
            })
            return message
          } catch (error) {
            await recordChannelDeliveryEvidence(delivery, {
              error: channelDeliveryError(error),
              type: "outbound.failed",
            })
            throw error
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return isRuntimeFunction(value) ? value.bind(target) : value
    },
  })
}

async function observeChannelDeliveryResponse(response: Response, delivery: AgentChannelDeliveryTracker, runId?: string): Promise<Response> {
  const terminalType = response.ok ? "completed" : response.status >= 500 ? "failed" : "rejected"
  if (!response.body) {
    await settleChannelDeliveryInvocation(delivery, "completed", terminalType, { runId })
    return response
  }
  const reader = response.body.getReader()
  let finished = false
  const complete = async () => {
    if (finished) return
    finished = true
    await settleChannelDeliveryInvocation(delivery, "completed", terminalType, { runId })
  }
  const fail = async (error: unknown) => {
    if (finished) return
    finished = true
    await settleChannelDeliveryInvocation(delivery, "failed", "failed", {
      error: channelDeliveryError(error),
      runId,
    })
  }
  return new Response(
    new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            await complete()
            controller.close()
          } else controller.enqueue(next.value)
        } catch (error) {
          await fail(error)
          controller.error(error)
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason)
        } finally {
          await fail(reason || new Error("Channel response stream was cancelled."))
        }
      },
    }),
    response,
  )
}

function githubInstallationId(payload: unknown): number | undefined {
  if (!payload || !isRuntimeObject(payload)) return
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const installation = (payload as { installation?: unknown }).installation
  if (!installation || !isRuntimeObject(installation)) return
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const id = (installation as { id?: unknown }).id
  return isRuntimeNumber(id) ? id : undefined
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
    if (isRuntimeString(stored) && stored) return stored
    await state.setIfNotExists(backendIdKey, globalThis.crypto.randomUUID())
    const backendId = await state.get(backendIdKey)
    if (!isRuntimeString(backendId) || !backendId) {
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
): Promise<{ keyPrefix: string; state: StateAdapter } | undefined> {
  const stateOption = handlerOptions.webhookState
  if (!stateOption) return
  const agentName = routeAgentIdentity(handlerOptions)?.name || "agent"
  const origin = chatRegistrationOrigin(registration)
  const registrationId = registration.id || registration.path || origin
  const keyPrefix = `webhook:${webhookScopeComponent(agentName)}:${webhookScopeComponent(origin)}:${webhookScopeComponent(registrationId)}:`
  // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
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
const maxWebhookQueueAttempts = 3

function positiveWebhookConcurrencyLimit(value: number | undefined): number | undefined {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("[vitehub] Webhook delivery ownership concurrencyLimit must be a positive integer.")
  }
  return value
}

function persistedWebhookRequest(
  deliveryId: string,
  channelDeliveryId: string,
  request: Request,
  body: string,
  webhookId: string,
  ownership: {
    concurrencyGroup?: string
    concurrencyKey?: string
    concurrencyLimit: number
    concurrencyTtlMs?: number
  },
  scope: string,
  agentName: string,
  invocation?: { input: unknown; run?: unknown },
  rehydrate?: boolean,
): AgentWebhookQueueDelivery {
  const enqueuedAt = Date.now()
  const concurrencyGroup = `${encodeURIComponent(agentName)}:${encodeURIComponent(ownership.concurrencyGroup?.trim() || "default")}`
  return {
    channelDeliveryId,
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
  if (value === null || isRuntimeString(value) || isRuntimeBoolean(value)) return true
  if (isRuntimeNumber(value)) return Number.isFinite(value)
  if (!value || !isRuntimeObject(value) || seen.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  seen.add(value)
  const safe = Object.values(value).every((entry) => isJsonSafe(entry, seen))
  seen.delete(value)
  return safe
}

function persistedWebhookInvocation(invocation: { input: AgentRunInput; run?: unknown }): { input: Record<string, unknown>; run?: unknown } {
  const input = Object.fromEntries(Object.entries(invocation.input).filter(([key]) => key !== "abortSignal"))
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

interface WebhookActiveInvocationScope {
  owner: "webhook"
}

async function steerQueuedWebhookDelivery(
  state: AgentWebhookQueueStateAdapter,
  activeInvocationScope: WebhookActiveInvocationScope,
  backendId: string,
  delivery: AgentWebhookQueueDelivery,
  input: AgentRunInput,
  waitUntil: AgentWaitUntil | undefined,
  fallback: (reserved?: boolean) => Promise<Response>,
): Promise<{ queued: boolean; response: Response; settlement?: Promise<boolean> } | undefined> {
  if (!delivery.concurrencyKey) return
  const claimKey = webhookOwnershipKey(delivery.scope, "steer", delivery.deliveryId)
  const duplicateResponse = (claim: unknown) =>
    claim === "queued"
      ? {
          queued: true,
          response: Response.json({ accepted: false, duplicate: true, ok: true, queued: false }),
        }
      : {
          queued: claim === "steering",
          response: Response.json({ accepted: false, duplicate: true, ok: true, steered: true }),
        }
  const existingClaim = await state.get(claimKey)
  if (existingClaim) {
    return duplicateResponse(existingClaim)
  }
  const lock = await state.acquireLock(webhookOwnershipKey(delivery.scope, "steer-lock", delivery.deliveryId), delivery.leaseTtlMs)
  if (!lock) {
    const claimed = await state.get(claimKey)
    if (claimed) {
      return duplicateResponse(claimed)
    }
    return {
      queued: false,
      response: Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }),
    }
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
        return {
          queued: false,
          response: Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }),
        }
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
        if (!(await state.claimWebhookSteering(delivery, steeringLease.leaseToken, steeringLease.leaseExpiresAt))) {
          const response = await fallback(false)
          await state.set(claimKey, "queued")
          return { queued: true, response }
        }
        try {
          await state.set(claimKey, "steering")
        } catch {
          await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now(), { incrementAttempts: false })
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
        } catch {}
        if (steeringLeaseLost || sendLockLost) {
          stopDeliveryHeartbeat()
          await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now(), { incrementAttempts: false })
          await state.delete(claimKey)
          return {
            queued: false,
            response: Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }),
          }
        }
        if (accepted) {
          keepLockUntilInvocationSettles = true
          const settlement = active.result
            .then(async () => {
              let completed: boolean
              try {
                completed = await state.completeWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken)
              } catch {
                await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now()).catch(() => false)
                await state.delete(claimKey).catch(() => undefined)
                return false
              }
              if (completed) await state.set(claimKey, "steered").catch(() => undefined)
              else await state.delete(claimKey).catch(() => undefined)
              return completed
            })
            .catch(async () => {
              await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now()).catch(() => false)
              await state.delete(claimKey).catch(() => undefined)
              return false
            })
            .finally(async () => {
              stopDeliveryHeartbeat()
              stopHeartbeat()
              await state.releaseLock(lock).catch(() => false)
            })
          waitUntil?.(settlement.then(() => undefined).catch(() => undefined))
          return {
            queued: false,
            response: Response.json({ accepted: true, ok: true, steered: true }),
            settlement,
          }
        }
        stopDeliveryHeartbeat()
        await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, steeringLease.leaseToken, Date.now(), { incrementAttempts: false })
        await state.set(claimKey, "queued")
        return { queued: true, response: await fallback(true) }
      } finally {
        stopSendHeartbeat()
        await state.releaseLock(sendLock)
      }
    }
    const response = await fallback(false)
    await state.set(claimKey, "queued")
    return { queued: true, response }
  } finally {
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
  if (!(await hasOnlyPortableAgentWorkflowCapabilities(context.capabilities))) return false
  if (agent.runtime.discoveryDefault !== true && !requireAvailable) return true
  if (agent.runtime.discoveryDefault === true && !context.agentIdentity) return false
  try {
    return Boolean((await loadAgentWorkflowRuntimeStateModule()).getWorkflowRuntimeConfig())
  } catch (error) {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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
      lock.expiresAt = knownLeaseExpiresAt
    } catch {
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

function startWebhookQueueHeartbeat(state: AgentWebhookQueueStateAdapter, delivery: AgentWebhookQueueLease, onLost: () => void): () => void {
  const intervalMs = Math.max(1, Math.floor(delivery.leaseTtlMs / 2))
  const retryMs = Math.max(1, Math.min(250, Math.floor(delivery.leaseTtlMs / 4)))
  let knownLeaseExpiresAt = delivery.leaseExpiresAt
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const extend = async () => {
    if (stopped) return
    const extensionStartedAt = Date.now()
    try {
      const extended = await state.extendWebhookDeliveryLease(delivery.scope, delivery.deliveryId, delivery.leaseToken, delivery.leaseTtlMs)
      if (stopped) return
      if (!extended) {
        stopped = true
        onLost()
        return
      }
      knownLeaseExpiresAt = extensionStartedAt + delivery.leaseTtlMs
    } catch {
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
  activeInvocationScope: WebhookActiveInvocationScope,
  backendId: string,
  delivery: AgentWebhookQueueLease,
  handlerOptions: AgentChannelWebhookRouteOptions,
  lifecycleSignal: AbortSignal,
): Promise<number | undefined> {
  if (delivery.attempts >= maxWebhookQueueAttempts) {
    const channelDelivery = delivery.channelDeliveryId ? await resumeAgentChannelDelivery(state, delivery.channelDeliveryId) : undefined
    if (await state.completeWebhookDelivery(delivery.scope, delivery.deliveryId, delivery.leaseToken)) {
      await channelDelivery
        ?.event({
          attempt: delivery.attempts,
          error: `Queued webhook delivery exhausted ${maxWebhookQueueAttempts} execution leases.`,
          type: "failed",
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
        })
        .catch(() => undefined)
      console.error(`[vitehub] Queued webhook delivery "${delivery.deliveryId}" exhausted ${maxWebhookQueueAttempts} execution leases and will not be retried.`)
    }
    return
  }
  let resolveActiveCompletion: (() => void) | undefined
  let rejectActiveCompletion: ((reason?: unknown) => void) | undefined
  const request = requestFromPersistedWebhook(delivery)
  const waitUntil = await resolveRuntimeWaitUntil(handlerOptions.waitUntil)
  let context = createRuntimeContext(
    request,
    undefined,
    waitUntil,
    handlerOptions.cloudflare,
    handlerOptions.runtime,
    handlerOptions.capabilities,
    routeAgentIdentity(handlerOptions),
  )
  const channelDelivery = delivery.channelDeliveryId ? await resumeAgentChannelDelivery(state, delivery.channelDeliveryId) : undefined
  if (channelDelivery) {
    context = withAgentChannelDelivery(context, channelDelivery)
  }
  const ownershipAbort = new AbortController()
  const stopHeartbeat = startWebhookQueueHeartbeat(state, delivery, () => {
    ownershipAbort.abort(new Error("[vitehub] Webhook queue lease was lost during Agent execution."))
  })
  if (channelDelivery) {
    if (delivery.attempts > 0)
      await recordChannelDeliveryEvidence(channelDelivery, {
        attempt: delivery.attempts + 1,
        type: "retrying",
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
      })
    await recordChannelDeliveryEvidence(channelDelivery, {
      attempt: delivery.attempts + 1,
      type: "invocation.started",
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    })
  }
  const stopForLifecycle = () => {
    ownershipAbort.abort(lifecycleSignal.reason)
  }
  if (lifecycleSignal.aborted) stopForLifecycle()
  else lifecycleSignal.addEventListener("abort", stopForLifecycle, { once: true })
  try {
    if (await hasActiveWorkflowRuntime(agent, context)) {
      throw new Error("[vitehub] Persisted webhook concurrency requires inline Agent execution.")
    }
    type PersistedInvocation = {
      input: AgentRunInput
      run?: Parameters<typeof createRuntimeContext>[1]
    }
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    let invocation = delivery.invocation as PersistedInvocation | undefined
    if (!invocation) {
      const resolved = await runWithRuntimeCloudflareEnv(context, async () => {
        const match = await findAgentWebhookRegistration(agent, context, request, delivery.webhookId)
        if (!match) throw new Error(`[vitehub] Persisted webhook registration "${delivery.webhookId}" no longer exists.`)
        const input = await createAgentWebhookTriggerInput(request, match.registration)
        const replayed = await resolveAgentTriggerInvocationWithResolvedContext(
          // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
          agent as never,
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          resolveRuntimeContext(context as never) as never,
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          match.trigger.id,
          input,
          { verifyWebhook: false },
        )
        if (delivery.rehydrate && isResolvedAgentTriggerHandledInvocation(replayed)) {
          throw new Error("[vitehub] Persisted webhook delivery requires rehydration, but its trigger handled the replayed request.")
        }
        if (!isResolvedAgentTriggerHandledInvocation(replayed) && delivery.rehydrate && !replayed.webhook?.rehydrate) {
          throw new Error("[vitehub] Persisted webhook delivery requires rehydration, but its trigger no longer provides a rehydrate callback.")
        }
        const resolved =
          !isResolvedAgentTriggerHandledInvocation(replayed) && delivery.rehydrate && replayed.webhook?.rehydrate
            ? resolveAgentTriggerInvocationResult(await replayed.webhook.rehydrate(), replayed.trigger)
            : replayed
        await context.flushWaitUntil?.()
        return resolved
      })
      if (!isResolvedAgentTriggerHandledInvocation(resolved)) {
        if (!resolved.webhook || resolved.webhook.deliveryId !== delivery.deliveryId) {
          throw new Error("[vitehub] Persisted webhook delivery no longer resolves to the same deliveryId.")
        }
        invocation = { input: resolved.input, run: resolved.run }
      }
    }
    if (invocation) {
      const baseRunContext = createRuntimeContext(
        request,
        invocation.run,
        waitUntil,
        handlerOptions.cloudflare,
        handlerOptions.runtime,
        handlerOptions.capabilities,
        routeAgentIdentity(handlerOptions),
      )
      const runContext = channelDelivery ? withAgentChannelDelivery(baseRunContext, channelDelivery) : baseRunContext
      await runWithRuntimeCloudflareEnv(runContext, async () => {
        const controller = await startAgentInvocation(
          // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
          agent as never,
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          runContext as never,
          // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
          {
            ...invocation.input,
            abortSignal: invocation.input.abortSignal ? AbortSignal.any([invocation.input.abortSignal, ownershipAbort.signal]) : ownershipAbort.signal,
          } as never,
          { runId: invocation.run?.runId },
        )
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
        else
          ownershipAbort.signal.addEventListener("abort", unregisterOnOwnershipLoss, {
            once: true,
          })
        try {
          await settlement
        } finally {
          ownershipAbort.signal.removeEventListener("abort", unregisterOnOwnershipLoss)
          unregister()
        }
      })
    }
    if (!(await state.completeWebhookDelivery(delivery.scope, delivery.deliveryId, delivery.leaseToken))) {
      throw new Error("[vitehub] Webhook queue completion lost its lease.")
    }
    if (channelDelivery)
      await settleChannelDeliveryInvocation(channelDelivery, "completed", "completed", {
        attempt: delivery.attempts + 1,
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
      })
    resolveActiveCompletion?.()
  } catch (error) {
    rejectActiveCompletion?.(error)
    if (!lifecycleSignal.aborted && delivery.attempts + 1 >= maxWebhookQueueAttempts) {
      if (await state.completeWebhookDelivery(delivery.scope, delivery.deliveryId, delivery.leaseToken)) {
        if (channelDelivery)
          await settleChannelDeliveryInvocation(channelDelivery, "failed", "failed", {
            attempt: delivery.attempts + 1,
            error: channelDeliveryError(error),
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          })
        console.error(
          `[vitehub] Queued webhook delivery "${delivery.deliveryId}" failed after ${maxWebhookQueueAttempts} attempts and will not be retried.`,
          error,
        )
      }
      return
    }
    const retryDelay = lifecycleSignal.aborted ? 0 : Math.min(60_000, defaultWebhookQueueRetryMs * 2 ** Math.min(delivery.attempts, 6))
    const retryAt = Date.now() + retryDelay
    if (await state.retryWebhookDelivery(delivery.scope, delivery.deliveryId, delivery.leaseToken, retryAt, { incrementAttempts: !lifecycleSignal.aborted })) {
      if (channelDelivery)
        await recordChannelDeliveryEvidence(channelDelivery, {
          attempt: delivery.attempts + 1,
          error: channelDeliveryError(error),
          type: "invocation.failed",
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
        })
      if (channelDelivery)
        await recordChannelDeliveryEvidence(channelDelivery, {
          attempt: delivery.attempts + 1,
          type: "retrying",
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          runId: (delivery.invocation?.run as AgentRunMetadata | undefined)?.runId,
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        })
      if (lifecycleSignal.aborted) return retryAt
      console.error(
        JSON.stringify({
          scope: "vitehub.channel.delivery",
          event: "retry.scheduled",
          deliveryId: delivery.channelDeliveryId,
          providerDeliveryId: delivery.deliveryId,
          attempt: delivery.attempts + 1,
          error: channelDeliveryError(error),
          retryAt: new Date(retryAt).toISOString(),
        }),
      )
      return retryAt
    }
    // A failed retry transition means this worker no longer owns the lease.
    // The worker that reclaimed it owns the eventual terminal evidence.
    if (channelDelivery) detachAgentChannelDelivery(channelDelivery)
  } finally {
    lifecycleSignal.removeEventListener("abort", stopForLifecycle)
    stopHeartbeat()
  }
}

async function resolveChatAdapters(options: AgentChatOptions | undefined, context: ViteAgentRouteRuntimeContext): Promise<Record<string, Adapter>> {
  const adapters = await resolveMaybe(
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
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
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  return Object.entries(adapters).filter(([name, adapter]) => name === "discord" || (adapter as { name?: unknown }).name === "discord")
}

async function resolveDiscordWebhookRegistration(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  adapters: Record<string, Adapter>,
  adapterName: string,
): Promise<AgentWebhookRegistrationDefinition | undefined> {
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const triggers = await resolveAgentTriggers(agent as never, context as never)
  const matches = Object.values(triggers).flatMap((trigger) =>
    (trigger.webhooks || []).filter((registration) => registration.provider === "discord" && resolveChatAdapterName(adapters, registration) === adapterName),
  )
  return matches.length === 1 ? matches[0] : undefined
}

function chatRegistrationOrigin(registration: AgentWebhookRegistrationDefinition): string {
  return registration.channelId || registration.provider
}

function objectWithoutUndefined<T extends Record<string, unknown>>(value: T): T {
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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
      const body = await result
        .clone()
        .json()
        .catch(() => undefined)
      if (isRecord(body) && isRuntimeString(body.text)) {
        return body.text
      }
    }
    return await result.text()
  }

  if (result && isRuntimeObject(result) && !isAsyncIterable(result) && !hasTraceableStreamResult(result)) {
    const descriptor = Object.getOwnPropertyDescriptor(result, "text")
    const text = descriptor && "value" in descriptor ? descriptor.value : undefined
    if (isRuntimeString(text)) return text.trim()
  }

  let explicitPhaseSeen = false
  let finalText = ""
  let unphasedText = ""
  for await (const event of streamAgentOutputToEvents(result)) {
    if (event.type === "text-delta") {
      if (event.phase === undefined) {
        if (!explicitPhaseSeen) unphasedText += event.text
      } else {
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
  const summary = isRecord(event.data) && isRuntimeString(event.data.summary) ? event.data.summary.trim() : ""
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
      await replaceManualDeliveryPlaceholder(manualDelivery.placeholder, {
        markdown: summary,
      }).catch(() => false)
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

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
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
        new Promise<void>((resolve) => {
          cancelTypingWait = resolve
          limit = setTimeout(resolve, chatTypingRefreshTimeoutMs)
        }),
      ])
    } finally {
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
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      } finally {
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

function streamAgentOutputToChatText(result: Promise<unknown>, onToolResult?: (result: AgentToolStepItem) => void): ChatTextStream {
  let collected = ""
  return {
    async *[Symbol.asyncIterator]() {
      const output = await result
      if (output instanceof Response) {
        if (output.headers.get("content-type")?.includes("application/json")) {
          const body = await output
            .clone()
            .json()
            .catch(() => undefined)
          if (isRecord(body)) {
            if (isRuntimeString(body.text)) {
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
      const events =
        output instanceof Response
          ? (async function* () {
              for await (const text of streamAgentOutputToChatText(Promise.resolve(output))) {
                // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
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
    } catch (error) {
      commentary.fail(error)
      final.fail(error)
      throw error
    } finally {
      commentary.close()
      final.close()
    }
  })()
  return { completion }
}

function chatStreamPostable(thread: Thread, response: ChatTextStream): ChatTextStream | StreamingPlan {
  return thread.adapter.stream ? new StreamingPlan(response, { updateIntervalMs: chatNativeStreamUpdateIntervalMs }) : response
}

function discordLongContentMode(adapter: Adapter): "split" | undefined {
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
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
  if (!isRuntimeObject(postable) || postable === null) return false
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const value = postable as { attachments?: unknown[]; files?: unknown[] }
  return (Array.isArray(value.attachments) && value.attachments.length > 0) || (Array.isArray(value.files) && value.files.length > 0)
}

function renderDiscordPostable(adapter: Adapter, postable: AdapterPostableMessage): string | undefined {
  if (hasChatFiles(postable)) return undefined
  if (isRuntimeObject(postable) && postable !== null && ("card" in postable || "type" in postable)) return undefined
  const adapterBoundary: unknown = adapter
  // SAFETY: Chat SDK adapters may expose this optional converter extension; optional access preserves adapters without it.
  const converter = (adapterBoundary as Adapter & { formatConverter?: { renderPostable?: (message: AdapterPostableMessage) => string } }).formatConverter
  if (converter?.renderPostable) {
    return convertEmojiPlaceholders(converter.renderPostable(postable), "discord")
  }
  if (isRuntimeString(postable)) return postable
  if (isRuntimeObject(postable) && postable !== null && "raw" in postable && isRuntimeString(postable.raw)) return postable.raw
  if (isRuntimeObject(postable) && postable !== null && "markdown" in postable && isRuntimeString(postable.markdown)) return postable.markdown
}

async function postDiscordSplitContent(thread: Thread, postable: AdapterPostableMessage, abortSignal?: AbortSignal): Promise<boolean> {
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

async function finishDiscordSplitStream(thread: Thread, sent: unknown, markdown: string, abortSignal?: AbortSignal): Promise<void> {
  if (!markdown || discordLongContentMode(thread.adapter) !== "split") return
  const rendered = renderDiscordPostable(thread.adapter, { markdown })
  if (!rendered || rendered.length <= discordMaxContentLength) return
  const [first, ...rest] = discordContentParts(rendered)
  const sentMessages = sent ? [sent] : []
  if (first && sent && isRuntimeObject(sent) && "edit" in sent && isRuntimeFunction(sent.edit)) {
    await sent.edit({ attachments: [], raw: first })
  } else if (first) {
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
  return sent && isRuntimeObject(sent) && "text" in sent && isRuntimeString(sent.text) ? sent.text : ""
}

async function removeAbortedChatDelivery(sent: unknown, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal?.aborted) return
  await deleteManualDeliveryPlaceholder(sent)
  abortSignal.throwIfAborted()
}

async function settleChatCleanup(task: Promise<unknown>, maximumDeadline?: number, abortSignal?: AbortSignal): Promise<void> {
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
  await enforceChatInvocationTimeout(abortableTask, maximumDeadline === undefined ? undefined : Math.max(0, maximumDeadline - Date.now())).catch(
    () => undefined,
  )
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
    // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
    sent = await thread.post(chatStreamPostable(thread, response) as never)
    await removeAbortedChatDelivery(sent, abortSignal)
    await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent), abortSignal)
    await removeAbortedChatDelivery(sent, abortSignal)
    return
  }

  if (thread.adapter.stream) {
    const adapter = thread.adapter
    const nativeStream = adapter.stream!.bind(adapter)
    const placeholder = fallback === null ? Promise.resolve(undefined) : adapter.postMessage(thread.id, fallback)
    let cleared = false
    let clearing: Promise<void> | undefined
    let clearRequested = false
    const clearPlaceholder = async () => {
      if (cleared) return
      if (clearing) return clearing
      clearing = settleChatCleanup(
        placeholder.then(async (message) => {
          if (!message?.id) return
          await adapter.deleteMessage(message.threadId || thread.id, message.id)
          cleared = true
        }),
        maximumDeadline,
        abortSignal,
      ).finally(() => {
        clearing = undefined
      })
      return clearing
    }
    const finishPlaceholder = () => {
      waitUntil(clearPlaceholder().then(() => (cleared || abortSignal?.aborted ? undefined : clearPlaceholder())))
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
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
    const chatThread = thread as Thread & {
      _adapter?: Adapter
      _fallbackStreamingPlaceholderText?: string | null
    }
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
        return isRuntimeFunction(value) ? value.bind(target) : value
      },
    })
    chatThread._fallbackStreamingPlaceholderText = fallback
    try {
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      sent = await thread.post(chatStreamPostable(thread, nativeResponse) as never)
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      await removeAbortedChatDelivery(sent, abortSignal)
      await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent), abortSignal)
      await removeAbortedChatDelivery(sent, abortSignal)
    } finally {
      abortSignal?.removeEventListener("abort", finishPlaceholder)
      chatThread._adapter = previousAdapter
      chatThread._fallbackStreamingPlaceholderText = previousFallback
      finishPlaceholder()
    }
    return
  }

  // ponytail: Chat SDK has no per-stream fallback option; replace this when it exposes one.
  const adapter = thread.adapter
  const placeholder = fallback === null ? Promise.resolve(undefined) : adapter.postMessage(thread.id, fallback)
  const clearPlaceholder = () => {
    waitUntil(
      settleChatCleanup(
        placeholder.then(async (message) => {
          if (message?.id) await adapter.deleteMessage(message.threadId || thread.id, message.id)
        }),
        maximumDeadline,
        abortSignal,
      ),
    )
  }
  abortSignal?.addEventListener("abort", clearPlaceholder, { once: true })
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const chatThread = thread as Thread & {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    _adapter?: Adapter
    _fallbackStreamingPlaceholderText?: string | null
  }
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
      return isRuntimeFunction(value) ? value.bind(target) : value
    },
  })
  chatThread._fallbackStreamingPlaceholderText = fallback
  try {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    sent = await thread.post(chatStreamPostable(thread, response) as never)
    await removeAbortedChatDelivery(sent, abortSignal)
    await finishDiscordSplitStream(thread, sent, response.getText() || sentMessageText(sent), abortSignal)
    await removeAbortedChatDelivery(sent, abortSignal)
  } finally {
    abortSignal?.removeEventListener("abort", clearPlaceholder)
    chatThread._adapter = previousAdapter
    chatThread._fallbackStreamingPlaceholderText = previous
  }
}

function randomToken(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function isExpired(expiresAt: number | null | undefined): boolean {
  return isRuntimeNumber(expiresAt) && expiresAt <= Date.now()
}

class ViteHubInMemoryChatStateAdapter implements StateAdapter {
  private cache = new Map<string, { expiresAt?: number; value: unknown }>()
  private connected = false
  private lists = new Map<string, Array<{ expiresAt?: number; value: unknown }>>()
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

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    this.ensureConnected()
    const expiresAt = options?.ttlMs ? Date.now() + options.ttlMs : undefined
    const list = (this.lists.get(key) || []).filter((item) => !isExpired(item.expiresAt))
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
    const queue = (this.queues.get(threadId) || []).filter((entry) => !isExpired(entry.expiresAt))
    const entry = queue.shift() || null
    this.queues.set(threadId, queue)
    return entry
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    this.ensureConnected()
    const queue = (this.queues.get(threadId) || []).filter((item) => !isExpired(item.expiresAt))
    queue.push(entry)
    const trimmed = maxSize > 0 ? queue.slice(-maxSize) : queue
    this.queues.set(threadId, trimmed)
    return trimmed.length
  }

  async queuePeek(threadId: string): Promise<QueueEntry | null> {
    this.ensureConnected()
    return (this.queues.get(threadId) || []).find((entry) => !isExpired(entry.expiresAt)) || null
  }

  async queueReplaceHead(threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number): Promise<boolean> {
    this.ensureConnected()
    const queue = (this.queues.get(threadId) || []).filter((entry) => !isExpired(entry.expiresAt))
    if (JSON.stringify(queue[0] || null) !== JSON.stringify(expected)) return false
    const next = [...replacement, ...queue.slice(expected === null ? 0 : 1)]
    this.queues.set(threadId, maxSize > 0 ? next.slice(-maxSize) : next)
    return true
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

  async get<T = unknown>(key: string, parse?: (value: unknown) => T): Promise<T | null> {
    this.ensureConnected()
    const item = this.cache.get(key)
    if (!item || isExpired(item.expiresAt)) {
      this.cache.delete(key)
      return null
    }
    if (parse) return parse(item.value)
    // SAFETY: MemoryState returns the exact value previously written under this key.
    return item.value as T
  }

  async getList<T = unknown>(key: string, parse?: (value: unknown) => T): Promise<T[]> {
    this.ensureConnected()
    const list = (this.lists.get(key) || []).filter((item) => !isExpired(item.expiresAt))
    this.lists.set(key, list)
    return list.map((item) => {
      if (parse) return parse(item.value)
      // SAFETY: MemoryState returns the exact list values previously appended under this key.
      return item.value as T
    })
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    this.ensureConnected()
    return this.subscriptions.has(threadId)
  }

  async queueDepth(threadId: string): Promise<number> {
    this.ensureConnected()
    const queue = (this.queues.get(threadId) || []).filter((entry) => !isExpired(entry.expiresAt))
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
  const scoped: StateAdapter = {
    async acquireLock(threadId, ttlMs) {
      const acquired = await state.acquireLock(key(threadId), ttlMs)
      return acquired ? { ...acquired, threadId } : null
    },
    appendToList: (listKey, value, options) => state.appendToList(key(listKey), value, options),
    connect: () => state.connect(),
    delete: (cacheKey) => state.delete(key(cacheKey)),
    dequeue: (threadId) => state.dequeue(key(threadId)),
    disconnect: async () => {
      // Scoped views share their backing state with other Channels and process handlers.
    },
    enqueue: (threadId, entry, maxSize) => state.enqueue(key(threadId), entry, maxSize),
    extendLock: (value, ttlMs) => state.extendLock(lock(value), ttlMs),
    forceReleaseLock: (threadId) => state.forceReleaseLock(key(threadId)),
    get: (cacheKey) => state.get(key(cacheKey)),
    getList: (listKey) => state.getList(key(listKey)),
    isSubscribed: (threadId) => state.isSubscribed(key(threadId)),
    queueDepth: (threadId) => state.queueDepth(key(threadId)),
    releaseLock: (value) => state.releaseLock(lock(value)),
    set: (cacheKey, value, ttlMs) => state.set(key(cacheKey), value, ttlMs),
    setIfNotExists: (cacheKey, value, ttlMs) => state.setIfNotExists(key(cacheKey), value, ttlMs),
    subscribe: (threadId) => state.subscribe(key(threadId)),
    unsubscribe: (threadId) => state.unsubscribe(key(threadId)),
  }
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const atomic = state as Partial<ReturnType<typeof requireAtomicAgentStateQueue>>
  if (isRuntimeFunction(atomic.queuePeek) && isRuntimeFunction(atomic.queueReplaceHead)) {
    Object.assign(scoped, {
      queuePeek: (threadId: string) => atomic.queuePeek!.call(state, key(threadId)),
      queueReplaceHead: (threadId: string, expected: QueueEntry | null, replacement: QueueEntry[], maxSize: number) =>
        atomic.queueReplaceHead!.call(state, key(threadId), expected, replacement, maxSize),
    })
  }
  return scoped
}

function stateResolverOwnsScope(state: unknown): boolean {
  if (isRuntimeFunction(state)) {
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
    return (state as typeof state & { ownsScope?: boolean }).ownsScope !== false
  }
  return isRecord(state) && isRuntimeFunction(state.resolve)
}

function stateResolverSupportsWorkflowCustody(state: unknown): boolean {
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  return (isRuntimeFunction(state) || isRecord(state)) && (state as { workflowCustody?: unknown }).workflowCustody === true
}

async function resolveChatState(
  options: AgentChatOptions | undefined,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  handlerOptions: AgentChannelWebhookRouteOptions,
): Promise<{ state: StateAdapter; titleKeyPrefix: string }> {
  const agentName = routeAgentIdentity(handlerOptions)?.name || context.agentIdentity?.name || "agent"
  const origin = chatRegistrationOrigin(registration)
  const agentKeyPrefix = `chat:${agentName}:`
  const stateKeyPrefix = `${agentKeyPrefix}${origin}:`
  const state = await resolveMaybe(
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    (options?.state ?? handlerOptions.state) as AgentChatStateResolver<ViteAgentRouteRuntimeConfig> | undefined,
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
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

async function resolveWorkflowAgentChannelDelivery(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  binding: AgentChannelDeliveryWorkflowBinding,
): Promise<AgentChannelDeliveryTracker | undefined> {
  const registration = {
    channelId: binding.channelId,
    id: binding.channelId,
    provider: binding.provider,
  }
  const handlerOptions = (await agentChannelDeliveryWorkflowStateResolver?.(context, binding)) || {}
  const webhookState = binding.state === "webhook" ? await resolveAgentWebhookState(context, registration, handlerOptions) : undefined
  const state =
    webhookState || (await resolveChatState(getChannelChatOptions(agent, binding.channelId, getAgentChatOptions(agent)), context, registration, handlerOptions))
  await state.state.connect()
  return await resumeAgentChannelDelivery(state.state, binding.deliveryId)
}

export function installAgentChannelDeliveryWorkflowResolver(): void {
  setAgentChannelDeliveryWorkflowResolver(
    async (agent, context, binding) =>
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      await resolveWorkflowAgentChannelDelivery(agent as AgentInput<ViteAgentRouteRuntimeContext>, context as ViteAgentRouteRuntimeContext, binding),
  )
  setAgentChannelDeliveryWorkflowOwnershipResolver(async (agent, context, binding) => {
    if (!binding.steer) return
    const registration = {
      channelId: binding.channelId,
      id: binding.channelId,
      provider: binding.provider,
    }
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    const handlerOptions = (await agentChannelDeliveryWorkflowStateResolver?.(context as ViteAgentRouteRuntimeContext, binding)) || {}
    const resolved = await resolveChatState(
      getChannelChatOptions(
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        agent as AgentInput<ViteAgentRouteRuntimeContext>,
        binding.channelId,
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        getAgentChatOptions(agent as AgentInput<ViteAgentRouteRuntimeContext>),
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      ),
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      context as ViteAgentRouteRuntimeContext,
      registration,
      handlerOptions,
    )
    await resolved.state.connect()
    requireAtomicAgentStateQueue(resolved.state)
    const { claimId, lock, pendingQueue: ownedPendingQueue, queue, ttlMs } = binding.steer
    const executionTtlMs = ttlMs
    const executionLock = await acquireRequiredStateLock(resolved.state, `${ownedPendingQueue}:execution:${claimId}`, executionTtlMs)
    let ownershipLost = false
    const executionAbort = new AbortController()
    const loseOwnership = () => {
      ownershipLost = true
      if (!executionAbort.signal.aborted) executionAbort.abort(new Error("[vitehub] Durable steered Channel delivery lost execution ownership."))
    }
    const stopExecutionHeartbeat = startWebhookLockHeartbeat(resolved.state, executionLock, executionTtlMs, loseOwnership)
    let pending: DurableSteerQueueEntry | null
    try {
      const ownerExtensionStartedAt = Date.now()
      if (!(await resolved.state.extendLock(lock, ttlMs))) {
        const recoveryLock = await acquireRequiredStateLock(resolved.state, `${lock.threadId}:handoff`, ttlMs)
        let recoveryOwnershipLost = false
        const stopRecoveryHeartbeat = startWebhookLockHeartbeat(resolved.state, recoveryLock, ttlMs, () => {
          recoveryOwnershipLost = true
        })
        try {
          pending = await claimDurableSteerPending(resolved.state, ownedPendingQueue, lock.token, claimId)
          if (pending?.message?.input) {
            if (pending.message.settlementStatus === "failed" && pending.message.settlementError) {
              await failDurableSteerQueue(
                resolved.state,
                queue,
                ownedPendingQueue,
                pending,
                new Error(pending.message.settlementError),
                async (delivery, failure) =>
                  await postDurableSteerErrorFallback(
                    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                    agent as AgentInput<ViteAgentRouteRuntimeContext>,
                    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                    context as ViteAgentRouteRuntimeContext,
                    registration,
                    resolved.state,
                    delivery,
                    failure,
                    Date.now(),
                  ),
              )
              stopExecutionHeartbeat()
              await resolved.state.releaseLock(executionLock).catch(() => undefined)
              return { retrySettlementFailures: true, settlementStatus: "failed", verify: async () => undefined, settle: async () => undefined }
            }
            await restoreDurableSteerQueue(resolved.state, queue, pending.message)
            if (!(await acknowledgeDurableSteerPending(resolved.state, ownedPendingQueue, pending))) {
              throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during recovery.")
            }
            const atomicQueue = requireAtomicAgentStateQueue(resolved.state)
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            const restored = (await atomicQueue.queuePeek(queue)) as DurableSteerQueueEntry | null
            if (restored?.message?.input) {
              const recoveredLock = await acquireRequiredStateLock(resolved.state, lock.threadId, ttlMs)
              let recoveredOwnershipLost = false
              const stopRecoveredHeartbeat = startWebhookLockHeartbeat(resolved.state, recoveredLock, ttlMs, () => {
                recoveredOwnershipLost = true
              })
              const recoveredClaimId = crypto.randomUUID()
              const recoveredDelivery = restored.message.input.context?.[agentChannelDeliveryWorkflowContextKey]
              const recoveredInput: AgentRunInput = {
                ...restored.message.input,
                context: {
                  ...restored.message.input.context,
                  [agentChannelDeliveryWorkflowContextKey]: {
                    ...(isRecord(recoveredDelivery) ? recoveredDelivery : {}),
                    steer: {
                      ...binding.steer,
                      claimId: recoveredClaimId,
                      deliveryIds: durableSteerMergedDeliveryIds(restored.message, isRecord(recoveredDelivery) ? recoveredDelivery.deliveryId : undefined),
                      lock: recoveredLock,
                      pendingQueue: ownedPendingQueue,
                    },
                  },
                },
              }
              const recoveredPending: DurableSteerQueueEntry = {
                enqueuedAt: Date.now(),
                expiresAt: Number.MAX_SAFE_INTEGER,
                message: {
                  ...restored.message,
                  claimId: recoveredClaimId,
                  input: recoveredInput,
                  ownerToken: recoveredLock.token,
                },
              }
              // SAFETY: recoveredPending is normalized durable queue data owned by this route boundary.
              await resolved.state.enqueue(ownedPendingQueue, recoveredPending as never, 1)
              // SAFETY: restored was read from this atomic queue and retains its internal entry representation.
              if (!(await atomicQueue.queueReplaceHead(queue, restored as never, [], durableSteerQueueMaximum))) {
                stopRecoveredHeartbeat()
                await acknowledgeDurableSteerPending(resolved.state, ownedPendingQueue, recoveredPending)
                await resolved.state.releaseLock(recoveredLock).catch(() => undefined)
                throw new Error("[vitehub] Durable steered Channel delivery queue changed while restored ownership was being claimed.")
              }
              let recoveredWorkflowInput = recoveredInput
              if (restored.message.resolvedInvoker) {
                const recoveredInvoker = resolveInputAgentInvoker(recoveredInput.context)
                if (recoveredInvoker) recoveredWorkflowInput = withResolvedAgentInvokerInput(recoveredInput, recoveredInvoker)
              }
              try {
                if (recoveryOwnershipLost || recoveredOwnershipLost) {
                  throw new Error("[vitehub] Durable steered Channel delivery lost recovered startup ownership.")
                }
                // SAFETY: The owning route supplies normalized Agent and runtime values to the internal startup boundary.
                await startAgentInvocation(
                  // SAFETY: The route resolver receives the internal Agent representation expected by startup.
                  agent as never,
                  // SAFETY: The recovered context preserves the owning route context and portable provider fields.
                  {
                    ...context,
                    capabilities: restored.message.capabilities,
                    ...(restored.message.requestUrl ? { request: new Request(restored.message.requestUrl) } : {}),
                    ...(restored.message.run ? { run: restored.message.run } : {}),
                  } as never,
                  // SAFETY: recoveredWorkflowInput is reconstructed from persisted, normalized Agent input.
                  recoveredWorkflowInput as never,
                )
                if (!recoveryOwnershipLost && !(await resolved.state.extendLock(recoveryLock, ttlMs))) recoveryOwnershipLost = true
                if (!recoveredOwnershipLost && !(await resolved.state.extendLock(recoveredLock, ttlMs))) recoveredOwnershipLost = true
                if (recoveryOwnershipLost || recoveredOwnershipLost) {
                  throw new Error("[vitehub] Durable steered Channel delivery lost recovered startup ownership.")
                }
              } catch (error) {
                if (recoveryOwnershipLost || recoveredOwnershipLost) {
                  stopRecoveredHeartbeat()
                  await resolved.state.releaseLock(recoveredLock).catch(() => undefined)
                  throw error
                }
                if (!isAmbiguousAgentWorkflowStartFailure(error)) {
                  // Restore the expired Workflow's claim so a provider retry can autonomously
                  // attempt recovery again without waiting for another Channel webhook.
                  // SAFETY: Both entries came from this queue's normalized durable delivery payloads.
                  if (!(await atomicQueue.queueReplaceHead(ownedPendingQueue, recoveredPending as never, [pending] as never, 1))) {
                    stopRecoveredHeartbeat()
                    throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during failed-start restoration.")
                  }
                  stopRecoveredHeartbeat()
                  await resolved.state.releaseLock(recoveredLock).catch(() => undefined)
                  throw error
                }
              }
              stopRecoveredHeartbeat()
              stopExecutionHeartbeat()
              await resolved.state.releaseLock(executionLock).catch(() => undefined)
              return { settlementStatus: "completed", verify: async () => undefined, settle: async () => undefined }
            }
          }
        } finally {
          stopRecoveryHeartbeat()
          await resolved.state.releaseLock(recoveryLock).catch(() => undefined)
        }
        throw new Error("[vitehub] Durable steered Channel delivery lost ownership before its Agent Workflow started.")
      }
      lock.expiresAt = ownerExtensionStartedAt + ttlMs
      pending = await claimDurableSteerPending(resolved.state, ownedPendingQueue, lock.token, claimId)
      if (!pending?.message?.input) {
        throw new Error("[vitehub] Durable steered Channel delivery could not claim its persisted Agent Workflow input.")
      }
    } catch (error) {
      stopExecutionHeartbeat()
      await resolved.state.releaseLock(executionLock).catch(() => undefined)
      throw error
    }
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
    const claimedPending = pending as DurableSteerQueueEntry & { message: DurableSteerQueueMessage & { input: AgentRunInput } }
    const stopHeartbeat = startWebhookLockHeartbeat(resolved.state, lock, ttlMs, loseOwnership)
    const verify = async () => {
      executionAbort.signal.throwIfAborted()
      const extendWithinKnownLease = async (ownedLock: Lock, ownedTtlMs: number) => {
        const retryMs = Math.max(1, Math.min(250, Math.floor(ownedTtlMs / 4)))
        while (true) {
          const extensionStartedAt = Date.now()
          try {
            const extended = await resolved.state.extendLock(ownedLock, ownedTtlMs)
            if (extended) ownedLock.expiresAt = extensionStartedAt + ownedTtlMs
            return extended
          } catch (error) {
            executionAbort.signal.throwIfAborted()
            const remainingMs = ownedLock.expiresAt - Date.now()
            if (remainingMs <= 0) throw error
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryMs, remainingMs)))
          }
        }
      }
      let executionOwned = false
      let scopeOwned = false
      try {
        executionOwned = await extendWithinKnownLease(executionLock, executionTtlMs)
        scopeOwned = executionOwned && (await extendWithinKnownLease(lock, ttlMs))
      } catch (error) {
        loseOwnership()
        throw error
      }
      if (!executionOwned || !scopeOwned) {
        loseOwnership()
        executionAbort.signal.throwIfAborted()
      }
      ownershipLost = false
    }
    const settle = async (status: "completed" | "failed") => {
      let activePending: DurableSteerQueueEntry = claimedPending
      let handoffLock: Lock | undefined
      let stopHandoffHeartbeat: () => void = () => undefined
      let queued: DurableSteerQueueEntry | null = null
      let queuedAcknowledged = false
      let pendingQueue: string | undefined
      let pendingPersisted = false
      let successorClaimId: string | undefined
      let successorStartAttempted = false
      let ownerReleased = false
      try {
        handoffLock = await acquireRequiredStateLock(resolved.state, `${lock.threadId}:handoff`, ttlMs)
        stopHandoffHeartbeat = startWebhookLockHeartbeat(resolved.state, handoffLock, ttlMs, () => {
          ownershipLost = true
        })
        // A transient heartbeat error is not permanent ownership loss. The
        // token check below is the authority at settlement.
        await verify()
        if (activePending.message?.settlementStatus === "failed" && activePending.message.settlementError) {
          await failDurableSteerQueue(
            resolved.state,
            queue,
            ownedPendingQueue,
            activePending,
            new Error(activePending.message.settlementError),
            async (delivery, failure) =>
              await postDurableSteerErrorFallback(
                // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                agent as AgentInput<ViteAgentRouteRuntimeContext>,
                // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                context as ViteAgentRouteRuntimeContext,
                registration,
                resolved.state,
                delivery,
                failure,
                Date.now(),
              ),
          )
          await resolved.state.releaseLock(lock)
          ownerReleased = true
          return
        }
        if (!activePending.message?.settlementStatus) {
          const settlementPending: DurableSteerQueueEntry = {
            ...activePending,
            message: { ...claimedPending.message, ...activePending.message, settlementStatus: status },
          }
          if (
            // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
            !(await requireAtomicAgentStateQueue(resolved.state).queueReplaceHead(ownedPendingQueue, activePending as never, [settlementPending as never], 1))
          ) {
            loseOwnership()
            return
          }
          activePending = settlementPending
        }
        for (const deliveryId of binding.steer?.deliveryIds ?? []) {
          if (activePending.message?.settledDeliveryIds?.includes(deliveryId)) continue
          const mergedDelivery = await resumeAgentChannelDelivery(resolved.state, deliveryId)
          if (mergedDelivery) await settleChannelDeliveryInvocation(mergedDelivery, status, status)
          const settledPending: DurableSteerQueueEntry = {
            ...activePending,
            message: {
              ...activePending.message!,
              settledDeliveryIds: [...new Set([...(activePending.message?.settledDeliveryIds ?? []), deliveryId])],
            },
          }
          // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
          if (!(await requireAtomicAgentStateQueue(resolved.state).queueReplaceHead(ownedPendingQueue, activePending as never, [settledPending as never], 1))) {
            loseOwnership()
            return
          }
          activePending = settledPending
        }
        const atomicQueue = requireAtomicAgentStateQueue(resolved.state)
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        queued = (await atomicQueue.queuePeek(queue)) as DurableSteerQueueEntry | null
        if (!queued?.message?.input) {
          await resolved.state.releaseLock(lock)
          ownerReleased = true
          if (!(await acknowledgeDurableSteerPending(resolved.state, ownedPendingQueue, activePending))) return
          return
        }
        pendingQueue = durableSteerPendingQueue(queue)
        successorClaimId = crypto.randomUUID()
        let queuedInput = queued.message.input
        if (queued.message.resolvedInvoker) {
          const queuedInvoker = resolveInputAgentInvoker(queuedInput.context)
          if (queuedInvoker) queuedInput = withResolvedAgentInvokerInput(queuedInput, queuedInvoker)
        }
        const queuedDelivery = queuedInput.context?.[agentChannelDeliveryWorkflowContextKey]
        const successorInput: AgentRunInput = {
          ...queuedInput,
          context: {
            ...queuedInput.context,
            [agentChannelDeliveryWorkflowContextKey]: {
              ...(isRecord(queuedDelivery) ? queuedDelivery : {}),
              steer: {
                ...binding.steer,
                claimId: successorClaimId,
                deliveryIds: queued.message.deliveryIds,
                pendingQueue,
              },
            },
          },
        }
        const successorPending: DurableSteerQueueEntry = {
          enqueuedAt: Date.now(),
          expiresAt: Number.MAX_SAFE_INTEGER,
          message: { ...queued.message, claimId: successorClaimId, input: successorInput, ownerToken: lock.token },
        }
        // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
        if (!(await atomicQueue.queueReplaceHead(pendingQueue, activePending as never, [successorPending as never], 1))) {
          throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during successor handoff.")
        }
        pendingPersisted = true
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        if (!(await atomicQueue.queueReplaceHead(queue, queued as never, [], durableSteerQueueMaximum))) {
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          throw new Error("[vitehub] Durable steered Channel delivery queue changed while its successor was being claimed.")
        }
        queuedAcknowledged = true
        successorStartAttempted = true
        await runAgent(
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          agent as never,
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          {
            ...context,
            capabilities: queued.message.capabilities,
            ...(queued.message.requestUrl ? { request: new Request(queued.message.requestUrl) } : {}),
            ...(queued.message.run ? { run: queued.message.run } : {}),
          } as never,
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          successorInput as never,
        )
      } catch (error) {
        if (ownerReleased) return
        if (successorStartAttempted && isAmbiguousAgentWorkflowStartFailure(error)) return
        if (ownershipLost && queued?.message?.input) {
          stopHandoffHeartbeat()
          if (handoffLock) await resolved.state.releaseLock(handoffLock).catch(() => undefined)
          handoffLock = await acquireRequiredStateLock(resolved.state, `${lock.threadId}:handoff`, ttlMs)
          stopHandoffHeartbeat = startWebhookLockHeartbeat(resolved.state, handoffLock, ttlMs, () => undefined)
        }
        let successorPending =
          pendingQueue && pendingPersisted && successorClaimId
            ? await claimDurableSteerPending(resolved.state, pendingQueue, lock.token, successorClaimId)
            : null
        if (successorStartAttempted) {
          if (!pendingQueue || !successorPending?.message?.input) return
          successorPending = await recordDurableSteerTerminalFailure(resolved.state, pendingQueue, successorPending, error)
          if (!successorPending?.message?.input) {
            throw new Error("[vitehub] Durable steered Channel delivery failure could not be persisted for settlement retry.", { cause: error })
          }
          try {
            await failDurableSteerQueue(
              resolved.state,
              queue,
              pendingQueue,
              successorPending,
              error,
              async (delivery, failure) =>
                await postDurableSteerErrorFallback(
                  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                  agent as AgentInput<ViteAgentRouteRuntimeContext>,
                  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                  context as ViteAgentRouteRuntimeContext,
                  registration,
                  resolved.state,
                  delivery,
                  failure,
                  Date.now(),
                ),
            )
          } catch (settlementError) {
            let retryInput = successorPending.message.input
            if (successorPending.message.resolvedInvoker) {
              const retryInvoker = resolveInputAgentInvoker(retryInput.context)
              if (retryInvoker) retryInput = withResolvedAgentInvokerInput(retryInput, retryInvoker)
            }
            try {
              await startAgentInvocation(
                // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
                agent as never,
                // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                {
                  ...context,
                  capabilities: successorPending.message.capabilities,
                  ...(successorPending.message.requestUrl ? { request: new Request(successorPending.message.requestUrl) } : {}),
                  ...(successorPending.message.run ? { run: successorPending.message.run } : {}),
                } as never,
                // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                retryInput as never,
              )
            } catch (retryError) {
              if (isAmbiguousAgentWorkflowStartFailure(retryError)) return
              throw new AggregateError(
                [error, settlementError, retryError],
                "[vitehub] Durable steered Channel delivery terminal settlement retry could not start.",
              )
            }
            return
          }
          await resolved.state.releaseLock(lock).catch(() => undefined)
          return
        }
        if (pendingQueue && successorPending) {
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          if (!(await requireAtomicAgentStateQueue(resolved.state).queueReplaceHead(pendingQueue, successorPending as never, [activePending as never], 1))) {
            throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during settlement retry.")
          }
        }
        if (queuedAcknowledged && queued?.message?.input) {
          await restoreDurableSteerQueue(resolved.state, queue, queued.message)
        }
        let retryInput = claimedPending.message.input
        if (claimedPending.message.resolvedInvoker) {
          const retryInvoker = resolveInputAgentInvoker(retryInput.context)
          if (retryInvoker) retryInput = withResolvedAgentInvokerInput(retryInput, retryInvoker)
        }
        try {
          await startAgentInvocation(
            // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
            agent as never,
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            {
              // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
              ...context,
              capabilities: claimedPending.message.capabilities,
              ...(claimedPending.message.requestUrl ? { request: new Request(claimedPending.message.requestUrl) } : {}),
              ...(claimedPending.message.run ? { run: claimedPending.message.run } : {}),
            } as never,
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            retryInput as never,
          )
        } catch (retryError) {
          if (isAmbiguousAgentWorkflowStartFailure(retryError)) return
          throw new AggregateError([error, retryError], "[vitehub] Durable steered Channel delivery settlement retry could not start.")
        }
      } finally {
        stopHeartbeat()
        stopExecutionHeartbeat()
        stopHandoffHeartbeat()
        if (handoffLock) await resolved.state.releaseLock(handoffLock).catch(() => undefined)
        await resolved.state.releaseLock(executionLock).catch(() => undefined)
      }
    }
    return { abortSignal: executionAbort.signal, retrySettlementFailures: true, settlementStatus: claimedPending.message.settlementStatus, verify, settle }
  })
}

installAgentChannelDeliveryWorkflowResolver()

async function acquireRequiredStateLock(state: StateAdapter, key: string, ttlMs: number, abortSignal?: AbortSignal): Promise<Lock> {
  for (;;) {
    abortSignal?.throwIfAborted()
    const lock = await state.acquireLock(key, ttlMs)
    if (lock) return lock
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        abortSignal?.removeEventListener("abort", onAbort)
        resolve()
      }
      const timeout = setTimeout(finish, 10)
      const onAbort = () => {
        clearTimeout(timeout)
        reject(abortSignal?.reason)
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true })
      if (abortSignal?.aborted) onAbort()
    })
  }
}

function mergeDurableSteerInput(previous: AgentRunInput | undefined, current: AgentRunInput): AgentRunInput {
  if (!previous?.messages?.length || !current.messages?.length) return current
  const currentById = new Map(current.messages.map((message) => [message.id, message]))
  const previousIds = new Set(previous.messages.map((message) => message.id))
  const refreshedPrevious = previous.messages.map((message) => currentById.get(message.id) ?? message)
  const appended = current.messages.filter((message) => !previousIds.has(message.id))
  return appended.length ? { ...current, messages: [...refreshedPrevious, ...appended] } : { ...current, messages: refreshedPrevious }
}

interface DurableSteerQueueMessage {
  capabilities: Record<string, false>
  claimId?: string
  deliveryIds?: string[]
  errorDeliveries?: DurableSteerErrorDelivery[]
  input?: AgentRunInput
  invokerKey?: string
  ownerToken?: string
  requestUrl?: string
  resolvedInvoker?: boolean
  run?: AgentRunMetadata
  settledDeliveryIds?: string[]
  settlementError?: string
  settlementStatus?: "completed" | "failed"
}

interface DurableSteerErrorDelivery {
  capabilities?: Record<string, false>
  fallbackStatus?: "delivered" | "reserved"
  input: AgentRunInput
  message: {
    id?: string
    text: string
    threadId: string
  }
  requestUrl?: string
  run?: AgentRunMetadata
}

interface DurableSteerQueueEntry {
  enqueuedAt?: number
  expiresAt?: number
  message?: DurableSteerQueueMessage
}

const durableSteerQueueMaximum = Number.MAX_SAFE_INTEGER
const durableSteerFallbackProgressWriteAttempts = 2

function durableSteerPendingQueue(queue: string): string {
  return `${queue}:pending`
}

async function claimDurableSteerPending(state: StateAdapter, queue: string, ownerToken: string, claimId: string): Promise<DurableSteerQueueEntry | null> {
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const pending = (await requireAtomicAgentStateQueue(state).queuePeek(queue)) as DurableSteerQueueEntry | null
  const ownedTerminalFailure =
    pending?.message?.ownerToken === ownerToken && pending.message.settlementStatus === "failed" && pending.message.settlementError !== undefined
  return !pending || (pending.message?.ownerToken === ownerToken && (pending.message.claimId === claimId || ownedTerminalFailure)) ? pending : null
}

async function acknowledgeDurableSteerPending(state: StateAdapter, queue: string, pending: DurableSteerQueueEntry): Promise<boolean> {
  // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
  return await requireAtomicAgentStateQueue(state).queueReplaceHead(queue, pending as never, [], durableSteerQueueMaximum)
}

function durableSteerInvokerKey(message: DurableSteerQueueMessage | undefined): string {
  return message?.invokerKey ?? JSON.stringify(resolveInputAgentInvoker(message?.input?.context) ?? null)
}

function durableSteerDeliveryIds(message: DurableSteerQueueMessage | undefined): string[] {
  const deliveryId = durableSteerPrimaryDeliveryId(message?.input)
  return [...new Set([...(message?.deliveryIds ?? []), ...(deliveryId ? [deliveryId] : [])])]
}

function durableSteerPrimaryDeliveryId(input: AgentRunInput | undefined): string | undefined {
  const binding = input?.context?.[agentChannelDeliveryWorkflowContextKey]
  return isRecord(binding) && isRuntimeString(binding.deliveryId) ? binding.deliveryId : undefined
}

function durableSteerMergedDeliveryIds(message: DurableSteerQueueMessage | undefined, primaryDeliveryId: unknown): string[] {
  return [...new Set(message?.deliveryIds ?? [])].filter((deliveryId) => deliveryId !== primaryDeliveryId)
}

function mergeDurableSteerErrorDeliveries(...deliveries: Array<DurableSteerErrorDelivery[] | undefined>): DurableSteerErrorDelivery[] {
  const merged = new Map<string, DurableSteerErrorDelivery>()
  for (const delivery of deliveries.flatMap((item) => item ?? [])) {
    const key = `${delivery.message.threadId}:${delivery.message.id ?? delivery.run?.runId ?? ""}`
    const previous = merged.get(key)
    merged.set(key, {
      ...previous,
      ...delivery,
      ...(previous?.fallbackStatus === "delivered" || delivery.fallbackStatus === "delivered"
        ? { fallbackStatus: "delivered" as const }
        : previous?.fallbackStatus === "reserved" || delivery.fallbackStatus === "reserved"
          ? { fallbackStatus: "reserved" as const }
          : {}),
    })
  }
  return [...merged.values()]
}

async function postDurableSteerErrorFallback(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  state: StateAdapter,
  delivery: DurableSteerErrorDelivery,
  error: unknown,
  maximumInvocationDeadline: number,
): Promise<void> {
  const baseOptions = getAgentChatOptions(agent)
  const options = getChannelChatOptions(agent, registration.channelId, baseOptions)
  const deliveryContext: ViteAgentRouteRuntimeContext = {
    ...context,
    capabilities: delivery.capabilities,
    ...(delivery.requestUrl ? { request: new Request(delivery.requestUrl) } : {}),
    ...(delivery.run ? { run: delivery.run } : {}),
  }
  const adapters = await resolveChatAdapters(baseOptions, deliveryContext)
  const adapterName = resolveChatAdapterName(adapters, registration)
  const adapter = adapterName ? adapters[adapterName] : undefined
  if (!adapterName || !adapter) {
    throw new Error("[vitehub] Durable steered Channel error delivery could not resolve its configured Chat adapter.")
  }
  const chat = new Chat(createChatSdkConfig(adapterName, adapter, state, options))
  const delivered = await postChatErrorFallback(
    error,
    chat.thread(delivery.message.threadId),
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    delivery.message as ChatSdkMessage,
    options,
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    delivery.input as AgentChatMessageTriggerInput,
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    delivery.run,
    [],
    undefined,
    maximumInvocationDeadline,
  )
  if (!delivered) throw new Error("[vitehub] Durable steered Channel error fallback was not delivered before its deadline.")
}

async function recordDurableSteerFallbackStatus(
  state: StateAdapter,
  queue: string,
  entry: DurableSteerQueueEntry,
  index: number,
  fallbackStatus: DurableSteerErrorDelivery["fallbackStatus"],
): Promise<DurableSteerQueueEntry | null> {
  const delivery = entry.message?.errorDeliveries?.[index]
  if (!delivery) return entry
  const errorDeliveries = [...entry.message!.errorDeliveries!]
  errorDeliveries[index] = { ...delivery, fallbackStatus }
  const updated: DurableSteerQueueEntry = {
    ...entry,
    message: { ...entry.message!, errorDeliveries },
  }
  for (let attempt = 0; attempt < durableSteerFallbackProgressWriteAttempts; attempt++) {
    try {
      // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
      if (await requireAtomicAgentStateQueue(state).queueReplaceHead(queue, entry as never, [updated as never], durableSteerQueueMaximum)) return updated
    } catch {
      // A later attempt can still persist the same monotonic progress transition.
    }
  }
  return null
}

async function recordDurableSteerTerminalFailure(
  state: StateAdapter,
  queue: string,
  entry: DurableSteerQueueEntry,
  error: unknown,
): Promise<DurableSteerQueueEntry | null> {
  if (!entry.message) return entry
  const updated: DurableSteerQueueEntry = {
    ...entry,
    message: {
      ...entry.message,
      settlementError: channelDeliveryError(error),
      settlementStatus: "failed",
    },
  }
  for (let attempt = 0; attempt < durableSteerFallbackProgressWriteAttempts; attempt++) {
    try {
      // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
      if (await requireAtomicAgentStateQueue(state).queueReplaceHead(queue, entry as never, [updated as never], durableSteerQueueMaximum)) return updated
    } catch {
      // A later attempt can still persist the terminal recovery transition.
    }
  }
  return null
}

export async function deliverDurableSteerErrorFallbacks(
  state: StateAdapter,
  queue: string,
  entry: DurableSteerQueueEntry,
  error: unknown,
  deliverErrorFallback: (delivery: DurableSteerErrorDelivery, error: unknown) => Promise<void>,
): Promise<DurableSteerQueueEntry> {
  let active = entry
  for (let index = 0; index < (active.message?.errorDeliveries?.length ?? 0); index++) {
    let delivery = active.message?.errorDeliveries?.[index]
    if (!delivery || delivery.fallbackStatus === "delivered") continue
    if (delivery.fallbackStatus !== "reserved") {
      const reserved = await recordDurableSteerFallbackStatus(state, queue, active, index, "reserved")
      if (!reserved) {
        throw new Error("[vitehub] Durable steered Channel error fallback reservation could not be persisted.")
      }
      active = reserved
      delivery = active.message?.errorDeliveries?.[index]
      if (!delivery) continue
    }
    try {
      await deliverErrorFallback(delivery, error)
    } catch (deliveryError) {
      console.error({
        component: "@vite-hub/agent",
        error: serializeErrorForLog(deliveryError),
        event: "chat.message.error_fallback.failed",
        message_id: delivery.message.id,
        thread_id: delivery.message.threadId,
      })
      throw deliveryError
    }
    // The adapter boundary has at-least-once semantics: a worker can stop after
    // the external post succeeds but before this checkpoint. Recovery retries a
    // reserved delivery because adapters do not expose a transactional idempotency key.
    const delivered = await recordDurableSteerFallbackStatus(state, queue, active, index, "delivered")
    if (!delivered) {
      throw new Error("[vitehub] Durable steered Channel error fallback delivery could not be checkpointed.")
    }
    active = delivered
  }
  return active
}

async function failDurableSteerEntry(
  state: StateAdapter,
  queue: string,
  entry: DurableSteerQueueEntry,
  error: unknown,
  deliverErrorFallback: (delivery: DurableSteerErrorDelivery, error: unknown) => Promise<void>,
): Promise<DurableSteerQueueEntry> {
  let failed = await deliverDurableSteerErrorFallbacks(state, queue, entry, error, deliverErrorFallback)
  for (const deliveryId of durableSteerDeliveryIds(failed.message)) {
    if (failed.message?.settledDeliveryIds?.includes(deliveryId)) continue
    const delivery = await resumeAgentChannelDelivery(state, deliveryId)
    if (!delivery) throw new Error(`[vitehub] Durable steered Channel delivery ${JSON.stringify(deliveryId)} could not be resumed for terminal settlement.`)
    const input = { error: channelDeliveryError(error) }
    await delivery.event({ ...input, type: "invocation.failed" })
    await delivery.event({ ...input, type: "failed" })
    const settled: DurableSteerQueueEntry = {
      ...failed,
      message: {
        ...failed.message!,
        settledDeliveryIds: [...new Set([...(failed.message?.settledDeliveryIds ?? []), deliveryId])],
      },
    }
    // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
    if (!(await requireAtomicAgentStateQueue(state).queueReplaceHead(queue, failed as never, [settled as never], durableSteerQueueMaximum))) {
      throw new Error("[vitehub] Durable steered Channel delivery queue changed while terminal settlement progress was being recorded.")
    }
    failed = settled
  }
  return failed
}

async function failDurableSteerQueue(
  state: StateAdapter,
  queue: string,
  pendingQueue: string,
  failed: DurableSteerQueueEntry,
  error: unknown,
  deliverErrorFallback: (delivery: DurableSteerErrorDelivery, error: unknown) => Promise<void>,
): Promise<void> {
  if (!failed.message) return
  const atomicQueue = requireAtomicAgentStateQueue(state)
  for (;;) {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    let queued = (await atomicQueue.queuePeek(queue)) as DurableSteerQueueEntry | null
    if (!queued) break
    if (queued.message) queued = await failDurableSteerEntry(state, queue, queued, error, deliverErrorFallback)
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    if (!(await atomicQueue.queueReplaceHead(queue, queued as never, [], durableSteerQueueMaximum))) {
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      throw new Error("[vitehub] Durable steered Channel delivery queue changed during terminal settlement.")
    }
  }
  failed = await failDurableSteerEntry(state, pendingQueue, failed, error, deliverErrorFallback)
  if (!(await acknowledgeDurableSteerPending(state, pendingQueue, failed))) {
    throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during terminal settlement.")
  }
}

async function restoreDurableSteerQueue(state: StateAdapter, queue: string, previous: DurableSteerQueueMessage): Promise<void> {
  if (!previous.input) return
  const atomicQueue = requireAtomicAgentStateQueue(state)
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const newer = (await atomicQueue.queuePeek(queue)) as DurableSteerQueueEntry | null
  const newerMessage = newer?.message
  const sameInvoker = Boolean(
    previous.settlementStatus === undefined &&
    newerMessage?.input &&
    newerMessage.settlementStatus === undefined &&
    durableSteerInvokerKey(previous) === durableSteerInvokerKey(newerMessage),
  )
  let restoredMessage = previous
  if (newerMessage?.input && sameInvoker) {
    const restoredInput = mergeDurableSteerInput(previous.input, newerMessage.input)
    const restoredPrimaryDeliveryId = durableSteerPrimaryDeliveryId(restoredInput)
    restoredMessage = {
      ...previous,
      deliveryIds: [...new Set([...durableSteerDeliveryIds(previous), ...durableSteerDeliveryIds(newerMessage)])].filter(
        (deliveryId) => deliveryId !== restoredPrimaryDeliveryId,
      ),
      errorDeliveries: mergeDurableSteerErrorDeliveries(previous.errorDeliveries, newerMessage.errorDeliveries),
      input: restoredInput,
      capabilities: newerMessage.capabilities ?? previous.capabilities,
      requestUrl: newerMessage.requestUrl ?? previous.requestUrl,
      resolvedInvoker: newerMessage.resolvedInvoker ?? previous.resolvedInvoker,
      run: newerMessage.run ?? previous.run,
    }
  }
  const restored: DurableSteerQueueEntry = {
    enqueuedAt: Date.now(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    message: restoredMessage,
  }
  const replacement = sameInvoker ? [restored] : [restored, ...(newer ? [newer] : [])]
  // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
  if (!(await atomicQueue.queueReplaceHead(queue, newer as never, replacement as never, durableSteerQueueMaximum))) {
    throw new Error("[vitehub] Durable steered Channel delivery queue changed while its Agent Workflow input was being restored.")
  }
}

function chatSdkOption<T>(
  options: AgentChatOptions | undefined,
  key: keyof AgentChatOptions,
  parse?: (value: AgentChatOptions[keyof AgentChatOptions]) => T,
): T | undefined {
  const value = options?.[key]
  if (value === undefined) return
  if (parse) return parse(value)
  // SAFETY: each caller pairs a literal AgentChatOptions key with that property's declared type.
  return value as T
}

interface ChatLockTracker {
  refresh(lockKey: string): () => void
  state: StateAdapter
}

function createChatLockTracker(state: StateAdapter): ChatLockTracker {
  const locks = new Map<string, { lock: Lock; ttlMs: number }>()
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
          } finally {
            locks.delete(lockKey)
          }
        }
      }
      if (property === "releaseLock") {
        return async (lock: Lock) => {
          try {
            await target.releaseLock(lock)
          } finally {
            if (locks.get(lock.threadId)?.lock.token === lock.token) locks.delete(lock.threadId)
          }
        }
      }
      const value = Reflect.get(target, property)
      return isRuntimeFunction(value) ? value.bind(target) : value
    },
  })

  return {
    refresh(lockKey) {
      const tracked = locks.get(lockKey)
      if (!tracked) return () => undefined
      const interval = setInterval(
        () => {
          void state.extendLock(tracked.lock, tracked.ttlMs).then(
            (extended) => {
              if (!extended) clearInterval(interval)
            },
            () => clearInterval(interval),
          )
        },
        Math.max(1, Math.floor(tracked.ttlMs / 3)),
      )
      return () => clearInterval(interval)
    },
    state: trackedState,
  }
}

async function chatSdkLockKey(adapter: Adapter, threadId: string, options: AgentChatOptions | undefined): Promise<string> {
  const channelId = adapter.channelIdFromThreadId(threadId)
  const configuredScope = chatSdkOption<ChatConfig["lockScope"]>(options, "lockScope")
  const scope = isRuntimeFunction(configuredScope)
    ? await configuredScope({
        adapter,
        channelId,
        isDM: adapter.isDM?.(threadId) ?? false,
        threadId,
      })
    : (configuredScope ?? adapter.lockScope ?? "thread")
  if (scope === "channel") return channelId
  if (scope === "thread") return threadId
  return scope
}

function createChatSdkConfig(adapterName: string, adapter: Adapter, state: StateAdapter, options: AgentChatOptions | undefined): ChatConfig {
  const fallbackStreamingPlaceholderText = isRuntimeString(options?.fallbackStreamingPlaceholderText)
    ? options.fallbackStreamingPlaceholderText
    : options?.fallbackStreamingPlaceholderText === null
      ? null
      : undefined
  const identity: ChatConfig["identity"] =
    options?.identity ?? (options?.transcripts ? ({ author }) => (author.isBot === true ? null : `${adapterName}:${author.userId}`) : undefined)
  const concurrency = chatSdkOption<ChatConfig["concurrency"] | "parallel" | "serial" | "steer">(options, "concurrency")
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  return objectWithoutUndefined({
    adapters: { [adapterName]: adapter },
    // TODO: forward active Chat messages through Agent Invocation steering once
    // model and Workflow runtimes expose the same resumable input contract.
    concurrency: concurrency === "parallel" ? "concurrent" : concurrency === "serial" || concurrency === "steer" ? "queue" : concurrency,
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
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
    (message.author as { email?: unknown }).email,
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    (message.author as { mail?: unknown }).mail,
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
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
  const mimeType = isRuntimeString(attachment.mimeType) ? attachment.mimeType.split(";")[0]?.trim().toLowerCase() : undefined
  if (mimeType?.startsWith("text/") || (mimeType && textAttachmentMimeTypes.has(mimeType)) || mimeType?.endsWith("+json") || mimeType?.endsWith("+yaml")) {
    return true
  }
  const extension = attachment.name?.split(".").pop()?.toLowerCase()
  return !!extension && textAttachmentExtensions.has(extension)
}

function checkedTextAttachmentBytes(value: unknown, options: { rejectOversizedTextAttachments?: boolean } = {}): Uint8Array | undefined {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : undefined
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
  if (isRuntimeNumber(contentLength) && Number.isFinite(contentLength) && contentLength > chatTextAttachmentMaxBytes) {
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
  if (isRuntimeNumber(attachment.size) && attachment.size > chatTextAttachmentMaxBytes) {
    if (!options.rejectOversizedTextAttachments) return
    throw new Error(chatTextAttachmentOversizeMessage)
  }
  if (isRuntimeFunction(attachment.fetchData)) {
    try {
      return checkedTextAttachmentBytes(await attachment.fetchData(), options)
    } catch (error) {
      if (isTextAttachmentOversizeError(error)) throw error
      return undefined
    }
  }
  if (attachment.data instanceof Blob) {
    return checkedTextAttachmentBytes(await attachment.data.arrayBuffer(), options)
  }
  const bytes = checkedTextAttachmentBytes(attachment.data, options)
  if (bytes) return bytes
  if (!isRuntimeString(attachment.url) || !attachment.url) return undefined
  try {
    return await fetchTextAttachmentBytes(attachment.url, options)
  } catch (error) {
    if (isTextAttachmentOversizeError(error)) throw error
    return undefined
  }
}

async function textPartFromAttachment(
  attachment: Attachment,
  index: number,
  options: { rejectOversizedTextAttachments?: boolean } = {},
): Promise<MessagePart | undefined> {
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
  const declaredMediaType = isRuntimeString(attachment.mimeType) && attachment.mimeType ? attachment.mimeType : undefined
  const type =
    declaredMediaType?.startsWith("audio/") || (attachment.type === "audio" && !declaredMediaType)
      ? "audio"
      : declaredMediaType?.startsWith("image/") || (attachment.type === "image" && !declaredMediaType)
        ? "image"
        : "file"
  const mediaType = declaredMediaType ?? (type === "image" ? imageAttachmentMediaType(attachment) : undefined)
  const data = isAttachmentData(attachment.data) ? attachment.data : undefined
  const fetchData = isRuntimeFunction(attachment.fetchData)
    ? async () => {
        const value = await attachment.fetchData?.()
        const resolved = isAttachmentData(value) ? value : undefined
        if (!resolved) {
          throw new Error("[vitehub] Chat attachment fetchData() did not return supported attachment data.")
        }
        return resolved
      }
    : undefined
  const url = isRuntimeString(attachment.url) && attachment.url ? attachment.url : undefined
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
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  return part as AttachmentPart
}

function attachmentFallbackLabel(attachment: Attachment): string {
  if (isRuntimeString(attachment.type) && attachment.type) return attachment.type
  if (isRuntimeString(attachment.mimeType) && attachment.mimeType) return attachment.mimeType
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
  const summary = [...counts.entries()].map(([label, count]) => `${count} ${label}${count === 1 ? "" : "s"}`).join(", ")
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

async function chatMessagePartsWithReply(message: ChatSdkMessage, options: { rejectOversizedTextAttachments?: boolean } = {}): Promise<MessagePart[]> {
  const parts = await chatMessageParts(message, options)
  if (!parts.length || !message.replyTo) return parts
  const replyContext = chatReplyMetadata(message)!
  delete replyContext.text
  const replyParts: MessagePart[] = []
  if (message.replyTo.text) {
    replyParts.push({
      data: { text: message.replyTo.text },
      id: "reply-text-0",
      type: "data-chat-reply-text",
    })
  }
  for (const [index, source] of message.replyTo.attachments.entries()) {
    const part = attachmentPartFromAttachment(source, index)
    if (!part) continue
    const { data: _data, fetchData: _fetchData, ...attachment } = part
    replyParts.push({
      data: { attachment },
      id: `reply-${part.id || index + 1}`,
      type: "data-chat-reply-attachment",
    })
  }
  return [
    {
      data: { ...replyContext, kind: "reply_to_message" },
      id: "reply-context",
      type: "data-chat-reply-context",
    },
    ...replyParts,
    {
      data: { kind: "user_message", messageId: message.id },
      id: "user-message-context",
      type: "data-chat-user-message-context",
    },
    ...parts,
  ]
}

function chatReplyMetadata(message: ChatSdkMessage): Record<string, unknown> | undefined {
  const replyTo = message.replyTo
  if (!replyTo) return
  return objectWithoutUndefined({
    attachmentCount: replyTo.attachments.length,
    author: objectWithoutUndefined({
      fullName: replyTo.author.fullName,
      isBot: replyTo.author.isBot,
      isMe: replyTo.author.isMe,
      userId: replyTo.author.userId,
      userName: replyTo.author.userName,
    }),
    dateSent: isoDate(replyTo.metadata.dateSent),
    messageId: replyTo.id,
    text: replyTo.text,
  })
}

function chatMessageMetadata(thread: Thread, message: ChatSdkMessage, messageContext?: MessageContext): Record<string, unknown> | undefined {
  const platformChannelId = thread.adapter.channelIdFromThreadId(message.threadId)
  return objectWithoutUndefined({
    chat: objectWithoutUndefined({
      edited: message.metadata.edited,
      editedAt: isoDate(message.metadata.editedAt),
      isMention: message.isMention,
      messageId: message.id,
      replyTo: chatReplyMetadata(message),
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
    parts: await chatMessagePartsWithReply(message, options),
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
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const history = (thread as { _threadHistory?: unknown })._threadHistory
  if (!history || !isRuntimeObject(history)) return
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const getMessages = (history as { getMessages?: unknown }).getMessages
  if (!isRuntimeFunction(getMessages)) return
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  return history as ChatThreadHistoryCache
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
}

async function durableChatThreadMessages(thread: Thread, limit: number): Promise<ChatSdkMessage[]> {
  try {
    return (await chatThreadHistoryCache(thread)?.getMessages(thread.id, limit)) ?? []
  } catch {
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
    ...(await Promise.all(durable.map((item) => (item.id && message.id && item.id === message.id ? current : chatSdkMessageToUiMessage(item))))),
    ...fetchedNewestFirst.slice().reverse(),
  ].reduce<UIMessageLike[]>((deduped, item) => {
    if (!item.id) {
      deduped.push(item)
      return deduped
    }
    const existing = deduped.findIndex((message) => message.id === item.id)
    if (existing === -1) deduped.push(item)
    else deduped[existing] = item
    return deduped
  }, [])

  if (historyThroughCurrent && current.id) {
    const currentIndex = messages.findIndex((item) => item.id === current.id)
    messages = currentIndex >= 0 ? messages.slice(0, currentIndex + 1) : [current]
  } else if (!current.id || !messages.some((item) => item.id === current.id)) {
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
  deliveryId?: string,
): AgentChatMessageTriggerInput {
  const platformChannelId = thread.adapter.channelIdFromThreadId(message.threadId)
  const runId = `${provider}:${message.id || deliveryId}`
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
    messages: scopeCurrentChatUiMessage(messages, message.id, runId),
    run: {
      channelId: channelId || platformChannelId,
      messageId: message.id,
      origin: provider,
      runId,
      threadId: message.threadId,
    },
    user,
  }
}

function scopeCurrentChatUiMessage(messages: UIMessageLike[], messageId: string | undefined, scope: string): UIMessageLike[] {
  const currentIndex = messageId ? messages.findIndex((message) => message.id === messageId) : messages.length - 1
  const current = messages[currentIndex]
  if (!current || current.id) return messages
  return messages.map((message, index) => (index === currentIndex ? { ...message, id: `${scope}:ui-${index}` } : message))
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
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const metadata = inputMessage?.metadata && isRuntimeObject(inputMessage.metadata) ? (inputMessage.metadata as Record<string, unknown>) : undefined
  return {
    error,
    publicError: toAgentPublicError(error, "http"),
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
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        await postChatMessage(thread, postedMessage as AgentChatMessage, abortSignal)
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        onPost?.()
      },
    },
  }
}

function isTextChatMessage(message: AgentChatMessage): message is { text: string } {
  return isRuntimeObject(message) && message !== null && "text" in message && isRuntimeString(message.text)
}

function chatMessageDeliveryArtifacts(message: AgentChatMessage): readonly PublishedAgentDeliveryArtifact[] {
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const artifacts = (message as { artifacts?: unknown }).artifacts
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  return Array.isArray(artifacts) ? (artifacts as readonly PublishedAgentDeliveryArtifact[]) : []
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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
  if (!isRuntimeObject(message) || message === null) {
    if (await postDiscordSplitContent(thread, message, abortSignal)) return
    await removeAbortedChatDelivery(await thread.post(message), abortSignal)
    return
  }

  const attachments = deliveryArtifactAttachments(chatMessageDeliveryArtifacts(message))
  if (!attachments.length) {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    const postable = isTextChatMessage(message) ? message.text : (message as AdapterPostableMessage)
    if (await postDiscordSplitContent(thread, postable, abortSignal)) return
    await removeAbortedChatDelivery(await thread.post(postable), abortSignal)
    return
  }

  if (isTextChatMessage(message)) {
    await removeAbortedChatDelivery(await thread.post({ attachments, raw: message.text }), abortSignal)
    return
  }

  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  const { artifacts: _artifacts, ...postable } = message as Exclude<AgentChatMessage, string | { text: string }> & {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    artifacts?: readonly PublishedAgentDeliveryArtifact[]
    attachments?: unknown
  }
  await removeAbortedChatDelivery(
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    await thread.post({
      ...postable,
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      attachments: [...(Array.isArray(postable.attachments) ? (postable.attachments as Attachment[]) : []), ...attachments],
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    } as AdapterPostableMessage),
    abortSignal,
  )
}

async function replaceManualDeliveryPlaceholder(placeholder: unknown, message: AgentChatMessage): Promise<boolean> {
  if (!placeholder || !isRuntimeObject(placeholder) || !("edit" in placeholder) || !isRuntimeFunction(placeholder.edit)) return false
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const target = placeholder as { edit: (message: unknown) => Promise<unknown> }
  if (isAsyncIterable(message)) {
    let markdown = ""
    for await (const chunk of message) markdown += chunk
    await target.edit({ markdown })
    return true
  }
  if (!isRuntimeObject(message) || message === null) {
    await target.edit(message)
    return true
  }
  if (deliveryArtifactAttachments(chatMessageDeliveryArtifacts(message)).length) return false
  await target.edit(isTextChatMessage(message) ? message.text : message)
  return true
}

async function deleteManualDeliveryPlaceholder(placeholder: unknown): Promise<void> {
  const message = "Manual chat delivery could not remove its placeholder."
  if (!placeholder || !isRuntimeObject(placeholder) || !("delete" in placeholder) || !isRuntimeFunction(placeholder.delete)) {
    throw new Error(message)
  }
  try {
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    await (placeholder as { delete: () => Promise<unknown> }).delete()
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  } catch (cause) {
    throw new Error(message, { cause })
  }
}

async function deliverToManualDeliveryPlaceholder(placeholder: unknown, message: AgentChatMessage, beforeDelete?: () => void): Promise<boolean> {
  if (!placeholder) return false
  if (await replaceManualDeliveryPlaceholder(placeholder, message).catch(() => false)) return true
  beforeDelete?.()
  await deleteManualDeliveryPlaceholder(placeholder)
  return false
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

export async function postChatErrorFallback(
  error: unknown,
  thread: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
  input: AgentChatMessageTriggerInput | undefined,
  run: AgentRunMetadata | undefined,
  toolResults: AgentToolStepItem[],
  manualDelivery?: ManualChatDeliveryState,
  maximumInvocationDeadline?: number,
): Promise<boolean> {
  console.error({
    component: "@vite-hub/agent",
    error: serializeErrorForLog(error),
    event: "chat.message.error",
    message_id: message.id,
    thread_id: message.threadId,
  })
  const fallbackResolutionTimeout =
    maximumInvocationDeadline === undefined
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
    () => callbackDelivered,
    (resolution) => enforceChatInvocationTimeout(resolution, fallbackResolutionTimeout, fallbackResolutionAbort),
  )
  const fallback = isRuntimeFunction(options?.errorFallbackText)
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
  const fallbackDelivery = (async (): Promise<boolean> => {
    if (!fallback) {
      if (fallbackPlaceholder) await deleteManualDeliveryPlaceholder(fallbackPlaceholder)
      return true
    }
    if (await deliverToManualDeliveryPlaceholder(fallbackPlaceholder, fallback)) return true
    fallbackDeliveryAbort?.signal.throwIfAborted()
    const sent = await thread.post(fallback).catch(() => undefined)
    if (!sent) return false
    if (fallbackDeliveryAbort?.signal.aborted) {
      await deleteManualDeliveryPlaceholder(sent)
      fallbackDeliveryAbort.signal.throwIfAborted()
    }
    return true
  })()
  if (maximumInvocationDeadline === undefined) return await fallbackDelivery
  return await enforceChatInvocationTimeout(
    fallbackDelivery,
    Math.max(0, maximumInvocationDeadline + cloudflareChatFallbackTimeoutMs - Date.now()),
    fallbackDeliveryAbort,
  ).catch(() => false)
}

function createChatFinishExtension(input: AgentChatMessageTriggerInput, registration: AgentWebhookRegistrationDefinition): AgentChatQueuedFinishExtension {
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

async function* abortableChatMessage(message: AsyncIterable<string>, abortSignal: AbortSignal): AsyncIterable<string> {
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
        iterator
          .next()
          .then(resolve, reject)
          .finally(() => {
            abortSignal.removeEventListener("abort", onAbort)
          })
      })
      if (next.done) return
      yield next.value
    }
  } finally {
    await close()
  }
}

async function collectAbortableChatMessage(message: AsyncIterable<string>, abortSignal: AbortSignal): Promise<{ markdown: string }> {
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
      message = manualDelivery.placeholder ? await collectAbortableChatMessage(message, abortSignal) : abortableChatMessage(message, abortSignal)
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
        } catch {
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
      } finally {
        if (manualDelivery.placeholderCleanup === placeholderCleanup) {
          manualDelivery.placeholderCleanup = undefined
        }
      }
      if (deliveredToPlaceholder) continue
    }
    await postChatMessage(thread, message, abortSignal)
  }
}

function withChatFinishExtension<CALL_OPTIONS>(input: AgentRunInput<CALL_OPTIONS>, chat: AgentChatFinishExtension): AgentRunInput<CALL_OPTIONS> {
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
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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

function chatInvocationTimeout(timeout: number | undefined, maximum: number | undefined): number | undefined {
  if (maximum === undefined) return timeout
  return timeout === undefined ? maximum : Math.min(timeout, maximum)
}

async function enforceChatInvocationTimeout<T>(task: Promise<T>, timeout: number | undefined, abortController?: AbortController): Promise<T> {
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
  } finally {
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
  state: { keyPrefix: string; state: StateAdapter; workflowCustodySupported?: boolean },
  messageContext?: MessageContext,
  maximumInvocationDeadline?: number,
  historyThroughCurrent = false,
  durableSteerScope?: string,
): Promise<void> {
  const delivery =
    agentChannelDeliveryTracker(context) ||
    (await openAgentChannelDelivery(state.state, {
      agentName: context.agentIdentity?.name || "agent",
      channelId: registration.channelId,
      provider: chatRegistrationOrigin(registration),
      scope: `${state.keyPrefix}${thread.id}`,
      sourceId: agentChannelDeliverySourceValue(message.id) || randomToken(),
    }))
  delivery.claimed = true
  context = withAgentChannelDelivery(context, delivery)
  thread = observeChatThread(thread, delivery)
  let input: AgentChatMessageTriggerInput | undefined
  let run: AgentRunMetadata | undefined
  let typing: ChatTypingRefresh | undefined
  let progress: ReturnType<typeof createManualDeliveryProgressUpdater> | undefined
  const manualDeliveryState: ManualChatDeliveryState = {}
  const toolResults: AgentToolStepItem[] = []
  const invocationDeadlineAbort = maximumInvocationDeadline === undefined ? undefined : new AbortController()
  let invocationStarted = false
  let invocationFailed = false
  let durableHandoff = false
  try {
    input = createChatTriggerInput(
      chatRegistrationOrigin(registration),
      thread,
      message,
      [chatAuthorizationUiMessage(thread, message, messageContext)],
      messageContext,
      registration.channelId,
      delivery.delivery.id,
    )
    if (isRuntimeNumber(options?.timeout) && Number.isFinite(options.timeout) && options.timeout > 0) {
      input.timeout = options.timeout
    }
    const authorizationInput = createChatMessageTriggerInput(options || {}, input).input
    const invoker = await isChatMessageAuthorized(agent, context, registration, thread, message, authorizationInput, input.run, messageContext)
    if (!invoker) {
      await recordChannelDeliveryEvidence(delivery, { type: "rejected" })
      return
    }

    const manualDelivery = options?.delivery === "manual"
    const streamsPhasedReplies = !manualDelivery && (options?.stream !== false || options?.commentary !== undefined)
    const messages = scopeCurrentChatUiMessage(
      await chatTriggerMessages(thread, message, options, messageContext, historyThroughCurrent),
      message.id,
      input.run?.runId || delivery.delivery.id,
    )
    const currentMessage = message.id ? messages.find((item) => item.id === message.id) : messages.at(-1)
    if (!currentMessage || !Array.isArray(currentMessage.parts) || currentMessage.parts.length === 0) {
      await recordChannelDeliveryEvidence(delivery, { type: "rejected" })
      return
    }
    const filter = options?.filter
    if (filter) {
      const [current] = uiMessagesToAgentMessages([currentMessage])
      if (
        !current ||
        !(await filter({
          ...context,
          deliveryKind,
          message: current,
          run: input.run,
          thread: {
            post: async (postedMessage) => await postChatMessage(thread, postedMessage),
          },
        }))
      ) {
        await recordChannelDeliveryEvidence(delivery, { type: "rejected" })
        return
      }
    }
    input = { ...input, messages }
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, "chat.message", input)
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    if (isResolvedAgentTriggerHandledInvocation(invocation)) {
      await recordChannelDeliveryEvidence(delivery, { type: "accepted" })
      await recordChannelDeliveryEvidence(delivery, { type: "completed" })
      return
    }

    typing = streamsPhasedReplies || manualDelivery ? startChatTypingRefresh(thread, context) : undefined
    assertChatDeliveryOptions(options || {})
    run = invocation.run
    await recordChannelDeliveryEvidence(delivery, { type: "accepted", runId: run?.runId })
    await recordChannelDeliveryEvidence(delivery, {
      type: "invocation.started",
      runId: run?.runId,
    })
    invocationStarted = true
    const runContext = {
      ...context,
      ...(invocation.run ? { run: invocation.run } : {}),
    }
    const durableDelivery =
      manualDelivery &&
      options?.durable !== false &&
      (options?.durable === true ||
        ((options?.concurrency === undefined || options.concurrency === "parallel" || options.concurrency === "steer") &&
          // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
          (await hasActiveWorkflowRuntime(agent as never, runContext as never, true))))
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
    const resolvedInvocationInput = invocation.input as AgentRunInput
    if (durableDelivery) {
      if (state.workflowCustodySupported === false) {
        throw new Error(
          "[vitehub] Durable Channel delivery requires reconstructable State across Agent Workflow custody. Configure Channel state or a generated host State provider.",
        )
      }
      const steerTtlMs = 5 * 60 * 1000
      const steerKey = durableSteerScope === undefined ? undefined : `${state.keyPrefix}durable-steer:${durableSteerScope}`
      const steerQueue = steerKey === undefined ? undefined : `${steerKey}:queue`
      if (steerKey) requireAtomicAgentStateQueue(state.state)
      const workflowBinding = {
        channelId: registration.channelId,
        deliveryId: delivery.delivery.id,
        provider: chatRegistrationOrigin(registration),
        // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
        state: "chat" as const,
      }
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      let workflowInput = withResolvedAgentInvokerInput(
        {
          ...resolvedInvocationInput,
          context: {
            ...resolvedInvocationInput.context,
            [agentChannelDeliveryWorkflowContextKey]: workflowBinding,
            [finalChannelOutputContextKey]: true,
            [requireAgentWorkflowContextKey]: true,
          },
        },
        invoker,
      ) as AgentRunInput
      let workflowInputHasResolvedInvoker = hasResolvedAgentInvokerInput(workflowInput)
      let workflowInvokerKey = JSON.stringify(resolveInputAgentInvoker(workflowInput.context) ?? null)
      let workflowCapabilities = portableWorkflowCapabilityOverrides(context.capabilities)
      let workflowRequestUrl = context.request.url
      let workflowRun = run
      let workflowRunContext = runContext
      let workflowSettlementError: DurableSteerQueueMessage["settlementError"]
      let workflowSettlementStatus: DurableSteerQueueMessage["settlementStatus"]
      if (steerKey) workflowInput = await portableAgentWorkflowInput(workflowInput)
      const currentErrorDelivery: DurableSteerErrorDelivery = {
        capabilities: workflowCapabilities,
        input: workflowInput,
        message: {
          ...(message.id ? { id: message.id } : {}),
          text: message.text,
          threadId: message.threadId,
        },
        requestUrl: workflowRequestUrl,
        ...(run ? { run } : {}),
      }
      let workflowErrorDeliveries = [currentErrorDelivery]
      const handoffTimeout = maximumInvocationDeadline === undefined ? undefined : AbortSignal.timeout(Math.max(0, maximumInvocationDeadline - Date.now()))
      const handoffAbort =
        resolvedInvocationInput.abortSignal && handoffTimeout
          ? AbortSignal.any([resolvedInvocationInput.abortSignal, handoffTimeout])
          : (resolvedInvocationInput.abortSignal ?? handoffTimeout)
      const steerHandoffLock = steerKey === undefined ? undefined : await acquireRequiredStateLock(state.state, `${steerKey}:handoff`, steerTtlMs, handoffAbort)
      let steerLock: Lock | undefined
      let workflowClaimId: string | undefined
      let reclaimedMessage: DurableSteerQueueMessage | undefined
      let reclaimedEntry: DurableSteerQueueEntry | null = null
      let reclaimingDeliveryQueued = false
      try {
        steerLock = steerKey === undefined ? undefined : ((await state.state.acquireLock(steerKey, steerTtlMs)) ?? undefined)
        if (steerLock && steerQueue) {
          workflowClaimId = crypto.randomUUID()
          workflowInput.context![agentChannelDeliveryWorkflowContextKey] = {
            ...workflowBinding,
            steer: {
              claimId: workflowClaimId,
              lock: steerLock,
              pendingQueue: durableSteerPendingQueue(steerQueue),
              queue: steerQueue,
              ttlMs: steerTtlMs,
            },
          }
        }
        if (steerKey && steerQueue && !steerLock) {
          const atomicQueue = requireAtomicAgentStateQueue(state.state)
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const previous = (await atomicQueue.queuePeek(steerQueue)) as DurableSteerQueueEntry | null
          const deliveryIds = durableSteerDeliveryIds(previous?.message)
          const sameInvoker =
            !previous?.message?.input || (previous.message.settlementStatus === undefined && durableSteerInvokerKey(previous.message) === workflowInvokerKey)
          const coalesceHead = sameInvoker && (await state.state.queueDepth(steerQueue)) === 1
          if (coalesceHead) workflowInput = mergeDurableSteerInput(previous?.message?.input, workflowInput)
          const queued: DurableSteerQueueEntry = {
            enqueuedAt: Date.now(),
            expiresAt: Number.MAX_SAFE_INTEGER,
            message: {
              capabilities: workflowCapabilities,
              deliveryIds: coalesceHead ? deliveryIds : [],
              errorDeliveries: coalesceHead
                ? mergeDurableSteerErrorDeliveries(previous?.message?.errorDeliveries, [currentErrorDelivery])
                : [currentErrorDelivery],
              input: workflowInput,
              invokerKey: workflowInvokerKey,
              requestUrl: workflowRequestUrl,
              resolvedInvoker: workflowInputHasResolvedInvoker,
              run,
            },
          }
          if (coalesceHead) {
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            if (!(await atomicQueue.queueReplaceHead(steerQueue, previous as never, [queued as never], durableSteerQueueMaximum))) {
              throw new Error("[vitehub] Durable steered Channel delivery queue changed while its matching invocation was being coalesced.")
            }
          } else {
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            await state.state.enqueue(steerQueue, queued as never, durableSteerQueueMaximum)
          }
          durableHandoff = true
          detachAgentChannelDelivery(delivery)
          await recordChannelDeliveryEvidence(delivery, { type: "queued", runId: run?.runId })
          if (steerHandoffLock) await state.state.releaseLock(steerHandoffLock).catch(() => undefined)
          return
        }
        // Acquiring ownership while a queued value exists means the previous
        // Workflow abandoned an expired lease. Preserve that accepted input and
        // its delivery records when the current message reclaims the scope.
        if (steerLock && steerQueue) {
          const atomicQueue = requireAtomicAgentStateQueue(state.state)
          const pendingQueue = durableSteerPendingQueue(steerQueue)
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const pending = (await atomicQueue.queuePeek(pendingQueue)) as DurableSteerQueueEntry | null
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          if (pending?.message?.input) {
            await restoreDurableSteerQueue(state.state, steerQueue, pending.message)
            if (!(await acknowledgeDurableSteerPending(state.state, pendingQueue, pending))) {
              throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during recovery.")
            }
          }
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const previous = (await atomicQueue.queuePeek(steerQueue)) as DurableSteerQueueEntry | null
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const deliveryIds = durableSteerDeliveryIds(previous?.message)
          const sameInvoker =
            !previous?.message?.input || (previous.message.settlementStatus === undefined && durableSteerInvokerKey(previous.message) === workflowInvokerKey)
          const coalesceHead = sameInvoker && (await state.state.queueDepth(steerQueue)) === 1
          if (coalesceHead) {
            reclaimedMessage = previous?.message
            workflowInput = mergeDurableSteerInput(previous?.message?.input, workflowInput)
            workflowErrorDeliveries = mergeDurableSteerErrorDeliveries(previous?.message?.errorDeliveries, [currentErrorDelivery])
            reclaimedEntry = previous
          } else if (previous?.message?.input) {
            await state.state.enqueue(
              steerQueue,
              // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
              {
                enqueuedAt: Date.now(),
                expiresAt: Number.MAX_SAFE_INTEGER,
                message: {
                  capabilities: workflowCapabilities,
                  deliveryIds: [],
                  errorDeliveries: [currentErrorDelivery],
                  input: workflowInput,
                  invokerKey: workflowInvokerKey,
                  requestUrl: workflowRequestUrl,
                  resolvedInvoker: workflowInputHasResolvedInvoker,
                  run: workflowRun,
                },
              } as never,
              durableSteerQueueMaximum,
            )
            reclaimingDeliveryQueued = true
            reclaimedMessage = previous.message
            reclaimedEntry = previous
            workflowInput = previous.message.input
            workflowInputHasResolvedInvoker = previous.message.resolvedInvoker === true
            workflowInvokerKey = durableSteerInvokerKey(previous.message)
            workflowCapabilities = previous.message.capabilities
            workflowRequestUrl = previous.message.requestUrl ?? workflowRequestUrl
            workflowErrorDeliveries = previous.message.errorDeliveries ?? []
            workflowRun = previous.message.run
            workflowSettlementError = previous.message.settlementError
            workflowSettlementStatus = previous.message.settlementStatus
            workflowRunContext = {
              ...context,
              capabilities: workflowCapabilities,
              ...(workflowRequestUrl ? { request: new Request(workflowRequestUrl) } : {}),
              run: workflowRun,
            }
          }
          if (workflowInputHasResolvedInvoker) {
            const recoveredInvoker = resolveInputAgentInvoker(workflowInput.context)
            if (recoveredInvoker) workflowInput = withResolvedAgentInvokerInput(workflowInput, recoveredInvoker)
          }
          const recoveredDelivery = workflowInput.context?.[agentChannelDeliveryWorkflowContextKey]
          const recoveredPrimaryDeliveryId = isRecord(recoveredDelivery) ? recoveredDelivery.deliveryId : undefined
          workflowInput.context![agentChannelDeliveryWorkflowContextKey] = {
            ...(isRecord(recoveredDelivery) ? recoveredDelivery : workflowBinding),
            steer: {
              claimId: workflowClaimId!,
              lock: steerLock,
              queue: steerQueue,
              pendingQueue: durableSteerPendingQueue(steerQueue),
              ttlMs: steerTtlMs,
              deliveryIds: sameInvoker ? deliveryIds : durableSteerMergedDeliveryIds(reclaimedMessage, recoveredPrimaryDeliveryId),
            },
          }
        }
      } catch (error) {
        if (steerLock) await state.state.releaseLock(steerLock).catch(() => undefined)
        if (steerHandoffLock) await state.state.releaseLock(steerHandoffLock).catch(() => undefined)
        throw error
      }
      const durableTyping = typing || startChatTypingRefresh(thread, context)
      typing = undefined
      const durableTypingTimeout = setTimeout(() => durableTyping.stop(), options?.timeout ?? 28_000)
      const steerStartLocks = [steerLock, steerHandoffLock].filter((lock): lock is Lock => lock != null)
      let steerStartOwnershipLost = false
      let retainSteerStartOwnership = false
      let steerPending: DurableSteerQueueEntry | undefined
      let steerPendingPersisted = false
      const stopSteerStartHeartbeats = steerStartLocks.map((lock) =>
        startWebhookLockHeartbeat(state.state, lock, steerTtlMs, () => {
          steerStartOwnershipLost = true
        }),
      )
      try {
        if (steerLock && steerQueue) {
          const workflowDelivery = workflowInput.context?.[agentChannelDeliveryWorkflowContextKey]
          const workflowSteer = isRecord(workflowDelivery) && isRecord(workflowDelivery.steer) ? workflowDelivery.steer : undefined
          steerPending = {
            enqueuedAt: Date.now(),
            expiresAt: Number.MAX_SAFE_INTEGER,
            message: {
              capabilities: workflowCapabilities,
              claimId: workflowClaimId,
              // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
              deliveryIds: Array.isArray(workflowSteer?.deliveryIds) ? (workflowSteer.deliveryIds as string[]) : [],
              errorDeliveries: workflowErrorDeliveries,
              input: workflowInput,
              invokerKey: workflowInvokerKey,
              ownerToken: steerLock.token,
              requestUrl: workflowRequestUrl,
              resolvedInvoker: workflowInputHasResolvedInvoker,
              run: workflowRun,
              ...(workflowSettlementError ? { settlementError: workflowSettlementError } : {}),
              ...(workflowSettlementStatus ? { settlementStatus: workflowSettlementStatus } : {}),
            },
          }
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          await state.state.enqueue(durableSteerPendingQueue(steerQueue), steerPending as never, 1)
          steerPendingPersisted = true
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          if (
            reclaimedEntry &&
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            !(await requireAtomicAgentStateQueue(state.state).queueReplaceHead(steerQueue, reclaimedEntry as never, [], durableSteerQueueMaximum))
          ) {
            throw new Error("[vitehub] Durable steered Channel delivery queue changed while ownership was being reclaimed.")
          }
        }
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        await runAgent(agent as never, workflowRunContext as never, workflowInput as never)
        durableHandoff = true
        if (steerStartOwnershipLost && steerLock && !(await state.state.extendLock(steerLock, steerTtlMs))) {
          throw new Error("[vitehub] Durable steered Channel delivery lost ownership while its Agent Workflow was starting.")
        }
        steerStartOwnershipLost = false
      } catch (error) {
        if (steerLock && steerQueue && steerPending && steerPendingPersisted && steerStartOwnershipLost) {
          durableHandoff = true
          await recordChannelDeliveryEvidence(delivery, { type: "queued", runId: run?.runId })
          detachAgentChannelDelivery(delivery)
          return
        }
        if (steerLock && steerQueue && steerPending && isAmbiguousAgentWorkflowStartFailure(error)) {
          durableHandoff = true
          await recordChannelDeliveryEvidence(delivery, { type: "queued", runId: run?.runId })
          detachAgentChannelDelivery(delivery)
          return
        }
        clearTimeout(durableTypingTimeout)
        durableTyping.stop()
        try {
          if (steerQueue && steerPending && steerPendingPersisted && !steerStartOwnershipLost) {
            const pendingQueue = durableSteerPendingQueue(steerQueue)
            if (reclaimingDeliveryQueued) {
              const failedPending = await recordDurableSteerTerminalFailure(state.state, pendingQueue, steerPending, error)
              if (!failedPending?.message?.input) {
                retainSteerStartOwnership = true
                durableHandoff = true
                detachAgentChannelDelivery(delivery)
                throw new Error("[vitehub] Durable steered Channel delivery failure could not be persisted for settlement retry.", { cause: error })
              }
              steerPending = failedPending
              try {
                await failDurableSteerQueue(
                  state.state,
                  steerQueue,
                  pendingQueue,
                  steerPending,
                  error,
                  async (delivery, failure) =>
                    await postDurableSteerErrorFallback(agent, context, registration, state.state, delivery, failure, maximumInvocationDeadline ?? Date.now()),
                )
              } catch (settlementError) {
                retainSteerStartOwnership = true
                durableHandoff = true
                try {
                  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                  await runAgent(agent as never, workflowRunContext as never, workflowInput as never)
                } catch (retryError) {
                  if (!isAmbiguousAgentWorkflowStartFailure(retryError)) {
                    detachAgentChannelDelivery(delivery)
                    throw new AggregateError(
                      [error, settlementError, retryError],
                      "[vitehub] Durable steered Channel delivery terminal settlement retry could not start.",
                    )
                  }
                }
                await recordChannelDeliveryEvidence(delivery, { type: "queued", runId: run?.runId })
                detachAgentChannelDelivery(delivery)
                return
              }
            } else {
              if (!(await acknowledgeDurableSteerPending(state.state, pendingQueue, steerPending))) {
                const failedPending = await recordDurableSteerTerminalFailure(state.state, pendingQueue, steerPending, error)
                retainSteerStartOwnership = true
                durableHandoff = true
                if (!failedPending?.message?.input) {
                  detachAgentChannelDelivery(delivery)
                  throw new Error("[vitehub] Durable steered Channel delivery failure could not be persisted for settlement retry.", { cause: error })
                }
                steerPending = failedPending
                try {
                  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                  await runAgent(agent as never, workflowRunContext as never, workflowInput as never)
                } catch (retryError) {
                  if (!isAmbiguousAgentWorkflowStartFailure(retryError)) {
                    detachAgentChannelDelivery(delivery)
                    throw new AggregateError(
                      [error, retryError],
                      "[vitehub] Durable steered Channel delivery failed-start settlement retry could not start.",
                    )
                  }
                }
                await recordChannelDeliveryEvidence(delivery, { type: "queued", runId: run?.runId })
                detachAgentChannelDelivery(delivery)
                return
              }
              if (reclaimedMessage?.input) {
                await restoreDurableSteerQueue(state.state, steerQueue, reclaimedMessage)
              }
            }
          } else if (steerQueue && steerPending && !steerPendingPersisted) {
            throw new Error("[vitehub] Durable steered Channel delivery pending ownership changed during failed Workflow startup.", { cause: error })
          }
        } finally {
          if (steerLock && !retainSteerStartOwnership) await state.state.releaseLock(steerLock).catch(() => undefined)
        }
        if (reclaimingDeliveryQueued) {
          durableHandoff = true
          detachAgentChannelDelivery(delivery)
          return
        }
        throw error
      } finally {
        for (const stop of stopSteerStartHeartbeats) stop()
        if (steerHandoffLock) await state.state.releaseLock(steerHandoffLock).catch(() => undefined)
      }
      // Workflow acceptance transfers ownership. Journal failures after this
      // point must not release the lock or restore input into the queue.
      await recordChannelDeliveryEvidence(delivery, { type: "queued", runId: run?.runId })
      detachAgentChannelDelivery(delivery)
      return
    }
    const thinkingFallback = invocation.metadata?.thinkingFallback
    if (manualDelivery && isRuntimeString(thinkingFallback)) {
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
    progress = manualDelivery ? createManualDeliveryProgressUpdater(manualDeliveryState, context.waitUntil, invocationDeadlineAbort?.signal) : undefined
    const remainingMaximumInvocationTimeout = maximumInvocationDeadline === undefined ? undefined : Math.max(0, maximumInvocationDeadline - Date.now())
    const invocationInput = withChatFinishExtension(
      withResolvedAgentInvokerInput(
        {
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
        },
        invoker,
      ),
      chatFinish,
    )
    if (!streamsPhasedReplies) {
      // Manual delivery disables Chat SDK reply streaming, but still consumes
      // normalized Agent events so transient Capability output can update the
      // framework-owned placeholder without exposing ordinary Agent text.
      await enforceChatInvocationTimeout(
        (async () => {
          const result = manualDelivery
            ? // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
              await streamAgent(agent as never, runContext as never, invocationInput as never, {
                output: "events",
              })
            : // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
              await runAgentInline(agent as never, runContext as never, invocationInput as never)
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const text = await collectAgentOutput(result, progress?.update, (toolResult) => toolResults.push(toolResult))
          if (!manualDelivery && text) {
            invocationDeadlineAbort?.signal.throwIfAborted()
            if (!(await postDiscordSplitContent(thread, { markdown: text }, invocationDeadlineAbort?.signal))) {
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
            } finally {
              if (manualDeliveryState.placeholderCleanup === placeholderCleanup) {
                manualDeliveryState.placeholderCleanup = undefined
              }
            }
          }
        })(),
        maximumInvocationDeadline === undefined ? undefined : invocationInput.timeout,
        invocationDeadlineAbort,
      )
    } else {
      await enforceChatInvocationTimeout(
        (async () => {
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const result = streamAgent(agent as never, runContext as never, invocationInput as never, {
            output: "events",
          })
          try {
            if (options?.stream === true || options?.commentary === undefined) {
              await postChatStream(
                thread,
                streamAgentOutputToChatText(result, (toolResult) => toolResults.push(toolResult)),
                isRuntimeString(thinkingFallback) || thinkingFallback === null ? thinkingFallback : undefined,
                context.waitUntil,
                invocationDeadlineAbort?.signal,
                maximumInvocationDeadline,
              )
            } else {
              const commentaryDeliveries: Promise<void>[] | undefined = maximumInvocationDeadline === undefined ? undefined : []
              let finalDelivery: Promise<void> | undefined
              let finalDeliveryError: unknown
              const replies = streamAgentOutputToChatReplies(result, {
                commentary: options.commentary,
                onToolResult: (toolResult) => toolResults.push(toolResult),
                onCommentary(response, discard) {
                  const delivery = postChatStream(
                    thread,
                    response,
                    undefined,
                    context.waitUntil,
                    invocationDeadlineAbort?.signal,
                    maximumInvocationDeadline,
                  ).catch(() => discard())
                  commentaryDeliveries?.push(delivery)
                  context.waitUntil(delivery)
                },
                onFinal(response) {
                  finalDelivery = postChatStream(
                    thread,
                    response,
                    isRuntimeString(thinkingFallback) || thinkingFallback === null ? thinkingFallback : undefined,
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
          } finally {
            typing?.stop()
          }
          await flushChatFinishExtensionMessages(thread, chatFinish, manualDeliveryState, invocationDeadlineAbort?.signal)
        })(),
        maximumInvocationDeadline === undefined ? undefined : invocationInput.timeout,
        invocationDeadlineAbort,
      )
    }
  } catch (error) {
    if (durableHandoff) throw error
    invocationFailed = true
    if (invocationStarted)
      await settleChannelDeliveryInvocation(delivery, "failed", "failed", {
        error: channelDeliveryError(error),
        runId: run?.runId,
      })
    else
      await recordChannelDeliveryEvidence(delivery, {
        error: channelDeliveryError(error),
        type: "failed",
        runId: run?.runId,
      })
    typing?.stop()
    await progress?.finish()
    await postChatErrorFallback(error, thread, message, options, input, run, toolResults, manualDeliveryState, maximumInvocationDeadline)
    throw error
  } finally {
    typing?.stop()
    if (invocationStarted && !invocationFailed && !durableHandoff) {
      await settleChannelDeliveryInvocation(delivery, "completed", "completed", {
        runId: run?.runId,
      })
    }
  }
}

type AgentMessageDeliveryKindResolver = (message: ChatSdkMessage) => MaybePromise<AgentMessageDeliveryKind | undefined>

function createChatSdkMessageThread(
  chat: Chat,
  adapter: Adapter,
  state: StateAdapter,
  source: Thread,
  message: ChatSdkMessage,
  options: AgentChatOptions | undefined,
): Thread {
  const fallbackStreamingPlaceholderText = isRuntimeString(options?.fallbackStreamingPlaceholderText)
    ? options.fallbackStreamingPlaceholderText
    : options?.fallbackStreamingPlaceholderText === null
      ? null
      : undefined
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
    // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
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
  state: { keyPrefix: string; state: StateAdapter },
  adapter: Adapter,
  chat: Chat,
  lockTracker: ChatLockTracker,
  messageContext?: MessageContext,
  maximumInvocationDeadline?: number,
): Promise<void> {
  const serial = chatSdkOption<string>(options, "concurrency") === "serial"
  const durableSteerScope = chatSdkOption<string>(options, "concurrency") === "steer" ? await chatSdkLockKey(adapter, thread.id, options) : undefined
  const messages = serial ? [...(messageContext?.skipped ?? []), message] : [message]
  const requestDelivery = agentChannelDeliveryTracker(context)
  if (requestDelivery) requestDelivery.claimed = true
  const stopRefreshingLock = serial ? lockTracker.refresh(await chatSdkLockKey(adapter, thread.id, options)) : () => undefined

  try {
    for (const queuedMessage of messages) {
      try {
        const queuedThread = serial ? createChatSdkMessageThread(chat, adapter, state.state, thread, queuedMessage, options) : thread
        const deliveryKind = serial ? await serialMessageDeliveryKind(queuedThread, queuedMessage) : await resolveDeliveryKind(queuedMessage)
        if (!deliveryKind) continue
        const queuedMessageId = agentChannelDeliverySourceValue(queuedMessage.id)
        const payloadFingerprint = await agentChannelDeliveryPayloadFingerprint(queuedMessage.raw).catch(() => undefined)
        const queuedDelivery = serial
          ? (payloadFingerprint ? await resumeAgentChannelDeliveryPayload(state.state, chatRegistrationOrigin(registration), payloadFingerprint) : undefined) ||
            (queuedMessageId
              ? (await resumeAgentChannelDeliveryMessage(state.state, chatRegistrationOrigin(registration), queuedMessage.threadId, queuedMessageId)) ||
                (queuedMessage !== message
                  ? await openAgentChannelDelivery(state.state, {
                      agentName: context.agentIdentity?.name || "agent",
                      channelId: registration.channelId,
                      provider: chatRegistrationOrigin(registration),
                      scope: `${state.keyPrefix}${queuedThread.id}`,
                      sourceId: queuedMessageId,
                    })
                  : undefined)
              : undefined)
          : undefined
        const queuedContext = queuedDelivery ? withAgentChannelDelivery(context, queuedDelivery) : context
        await handleChatSdkMessage(
          agent,
          queuedContext,
          registration,
          queuedThread,
          queuedMessage,
          deliveryKind,
          options,
          state,
          serial ? undefined : messageContext,
          maximumInvocationDeadline,
          serial,
          durableSteerScope,
        )
      } catch (error) {
        if (!serial) throw error
      }
    }
  } finally {
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
  providedState?: {
    state: StateAdapter
    titleKeyPrefix: string
    workflowCustodySupported?: boolean
  },
  resolveDelivery?: () => Promise<AgentChannelDeliveryTracker>,
): Promise<Chat> {
  const resolvedState = providedState || (await resolveChatState(options, context, registration, handlerOptions))
  const lockTracker = createChatLockTracker(resolvedState.state)
  const chat = new Chat(createChatSdkConfig(adapterName, adapter, lockTracker.state, options))
  const state = {
    keyPrefix: resolvedState.titleKeyPrefix,
    state: resolvedState.state,
    workflowCustodySupported: "workflowCustodySupported" in resolvedState ? resolvedState.workflowCustodySupported : undefined,
  }
  const deliveryContext = async () => (resolveDelivery ? withAgentChannelDelivery(context, await resolveDelivery()) : context)
  chat.onDirectMessage(async (thread, message, _channel, messageContext) =>
    handleChatSdkMessages(
      agent,
      await deliveryContext(),
      registration,
      thread,
      message,
      () => "direct",
      options,
      state,
      adapter,
      chat,
      lockTracker,
      messageContext,
      maximumInvocationDeadline,
    ),
  )
  chat.onNewMention(async (thread, message, messageContext) => {
    const messageRuntimeContext = await deliveryContext()
    if (chatSdkOption<string>(options, "concurrency") !== "serial") {
      await thread.subscribe().catch(() => undefined)
      await handleChatSdkMessages(
        agent,
        messageRuntimeContext,
        registration,
        thread,
        message,
        () => "mention",
        options,
        state,
        adapter,
        chat,
        lockTracker,
        messageContext,
        maximumInvocationDeadline,
      )
      return
    }
    await handleChatSdkMessages(
      agent,
      messageRuntimeContext,
      registration,
      thread,
      message,
      () => "mention",
      options,
      state,
      adapter,
      chat,
      lockTracker,
      messageContext,
      maximumInvocationDeadline,
    )
  })
  chat.onSubscribedMessage(async (thread, message, messageContext) =>
    handleChatSdkMessages(
      agent,
      await deliveryContext(),
      registration,
      thread,
      message,
      (queuedMessage) => (queuedMessage.isMention ? "mention" : "subscribed"),
      options,
      state,
      adapter,
      chat,
      lockTracker,
      messageContext,
      maximumInvocationDeadline,
    ),
  )

  return chat
}

function historyBytesToBase64(data: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

const channelHistoryAttachmentMaxBytes = 25 * 1024 * 1024
const channelHistoryArchiveMaxBytes = 35 * 1024 * 1024

function channelHistoryAttachmentBytes(value: unknown): Uint8Array | undefined {
  const bytes = value instanceof Blob ? undefined : value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : undefined
  return bytes && bytes.byteLength <= channelHistoryAttachmentMaxBytes ? bytes : undefined
}

async function boundedChannelHistoryOperation(operation: () => unknown | Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const abort = () => settle(reject, signal.reason)
    const timeout = setTimeout(() => settle(reject, new DOMException("Attachment read timed out.", "TimeoutError")), 30_000)
    const settle = (callback: (value: unknown) => void, value: unknown) => {
      clearTimeout(timeout)
      signal.removeEventListener("abort", abort)
      callback(value)
    }
    if (signal.aborted) {
      settle(reject, signal.reason)
      return
    }
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => settle(resolve, value),
        (error) => settle(reject, error),
      )
  })
}

function channelHistoryStringByteLength(value: string, mediaType: string): number | undefined {
  const dataUrl = /^data:([^,]*?),(.*)$/is.exec(value)
  const encoded = dataUrl?.[2] ?? value
  const base64 = dataUrl ? dataUrl[1]!.split(";").some((parameter) => parameter.toLowerCase() === "base64") : !isTextAttachmentDataMediaType(mediaType)
  if (base64) {
    let length = 0
    let padding = 0
    for (const character of encoded) {
      if (/\s/.test(character)) continue
      length++
      padding = character === "=" ? padding + 1 : 0
    }
    return Math.max(0, Math.floor((length * 3) / 4) - Math.min(padding, 2))
  }
  let bytes = 0
  for (let index = 0; index < encoded.length; ) {
    if (dataUrl && encoded[index] === "%") {
      if (!/^[\da-f]{2}$/i.test(encoded.slice(index + 1, index + 3))) return
      bytes++
      index += 3
      continue
    }
    const codePoint = encoded.codePointAt(index)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    index += codePoint > 0xffff ? 2 : 1
  }
  return bytes
}

function isTextAttachmentDataMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase()
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/xml" ||
    normalized.endsWith("+json") ||
    normalized.endsWith("+xml")
  )
}

async function channelHistoryAttachment(
  attachment: Attachment,
  adapter: Adapter,
  budget: { remaining: number },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const unavailable = (resolved: Attachment = attachment) =>
    objectWithoutUndefined({
      fetchMetadata: resolved.fetchMetadata,
      height: resolved.height,
      mimeType: resolved.mimeType,
      name: resolved.name,
      size: resolved.size,
      type: resolved.type,
      unavailable: true,
      url: resolved.url,
      width: resolved.width,
    })
  if (budget.remaining <= 0) return unavailable()
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const rehydrate = (adapter as Adapter & { rehydrateAttachment?: (attachment: Attachment) => Attachment }).rehydrateAttachment
  let resolved = attachment
  try {
    if (rehydrate && !attachment.fetchData) resolved = rehydrate.call(adapter, attachment)
  } catch {
    return unavailable()
  }
  const maxBytes = Math.min(channelHistoryAttachmentMaxBytes, budget.remaining)
  let data: unknown = isRuntimeNumber(resolved.size) && resolved.size > maxBytes ? undefined : resolved.data
  if (data instanceof Blob) data = data.size <= maxBytes ? new Uint8Array(await data.arrayBuffer()) : undefined
  const boundedLazySize = isRuntimeNumber(resolved.size) && Number.isFinite(resolved.size) && resolved.size >= 0 && resolved.size <= maxBytes
  if (!data && resolved.fetchData && boundedLazySize) {
    try {
      data = await boundedChannelHistoryOperation(() => resolved.fetchData!(), signal)
    } catch {}
  }
  let bytes: Uint8Array | undefined
  try {
    if (isRuntimeString(data)) {
      const mediaType = resolved.mimeType || "application/octet-stream"
      const byteLength = channelHistoryStringByteLength(data, mediaType)
      bytes = byteLength !== undefined && byteLength <= maxBytes ? attachmentStringBytes(data, mediaType) : undefined
    } else bytes = channelHistoryAttachmentBytes(data)
  } catch {}
  const boundedBytes = bytes && bytes.byteLength <= maxBytes ? bytes : undefined
  if (boundedBytes) budget.remaining -= boundedBytes.byteLength
  return objectWithoutUndefined({
    data: boundedBytes ? historyBytesToBase64(boundedBytes) : undefined,
    fetchMetadata: resolved.fetchMetadata,
    height: resolved.height,
    mimeType: resolved.mimeType,
    name: resolved.name,
    size: resolved.size,
    type: resolved.type,
    unavailable: !boundedBytes || undefined,
    url: boundedBytes ? undefined : resolved.url,
    width: resolved.width,
  })
}

function boundedJsonByteLength(value: unknown, maxBytes: number, seen = new Set<object>()): number | undefined {
  if (value === null) return 4
  if (isRuntimeBoolean(value)) return value ? 4 : 5
  if (isRuntimeNumber(value)) return Number.isFinite(value) ? String(value).length : 4
  if (isRuntimeString(value)) {
    let bytes = 2
    for (let index = 0; index < value.length; ) {
      const codePoint = value.codePointAt(index)!
      bytes +=
        codePoint === 0x22 || codePoint === 0x5c
          ? 2
          : codePoint >= 0xd800 && codePoint <= 0xdfff
            ? 6
            : codePoint <= 0x1f
              ? 6
              : codePoint <= 0x7f
                ? 1
                : codePoint <= 0x7ff
                  ? 2
                  : codePoint <= 0xffff
                    ? 3
                    : 4
      if (bytes > maxBytes) return
      index += codePoint > 0xffff ? 2 : 1
    }
    return bytes
  }
  if (!isRuntimeObject(value) || seen.has(value)) return
  seen.add(value)
  let bytes = Array.isArray(value) ? 2 : 2
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value)
  for (let index = 0; index < entries.length; index++) {
    const [key, item] = entries[index]!
    const itemBytes = boundedJsonByteLength(item, maxBytes - bytes, seen)
    if (itemBytes === undefined) return
    bytes += itemBytes + (index ? 1 : 0)
    if (!Array.isArray(value)) {
      const keyBytes = boundedJsonByteLength(key, maxBytes - bytes, seen)
      if (keyBytes === undefined) return
      bytes += keyBytes + 1
    }
    if (bytes > maxBytes) return
  }
  seen.delete(value)
  return bytes
}

function boundedUtf8ByteLength(value: string, maxBytes: number): number | undefined {
  let bytes = 0
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index)!
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes > maxBytes) return
    index += codePoint > 0xffff ? 2 : 1
  }
  return bytes
}

async function channelHistoryMessage(
  message: ChatSdkMessage,
  adapter: Adapter,
  budget: { remaining: number },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const attachments: Record<string, unknown>[] = []
  for (const attachment of message.attachments) {
    attachments.push(await channelHistoryAttachment(attachment, adapter, budget, signal))
  }
  return objectWithoutUndefined({
    attachments,
    author: message.author,
    formatted: message.formatted,
    id: message.id,
    isMention: message.isMention,
    links: message.links,
    metadata: objectWithoutUndefined({
      dateSent: message.metadata.dateSent.toISOString(),
      edited: message.metadata.edited,
      editedAt: isoDate(message.metadata.editedAt),
    }),
    replyTo: message.replyTo ? await channelHistoryMessage(message.replyTo, adapter, budget, signal) : undefined,
    text: message.text,
    threadId: message.threadId,
  })
}

async function createChannelHistoryResponse(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  context: ViteAgentRouteRuntimeContext,
  registration: AgentWebhookRegistrationDefinition,
  options: AgentChannelWebhookRouteOptions,
  request: Request,
): Promise<Response> {
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  const body = (await request.json().catch(() => undefined)) as { threadId?: unknown } | undefined
  if (!body || !isRuntimeString(body.threadId) || !body.threadId.trim()) {
    return createBadRequest("Channel history export requires threadId.")
  }
  const baseChatOptions = getAgentChatOptions(agent)
  const adapters = await resolveChatAdapters(baseChatOptions, context)
  const adapterName = resolveChatAdapterName(adapters, registration)
  const adapter = adapterName ? adapters[adapterName] : undefined
  if (!adapter) return createJsonErrorResponse(500, "Channel history export could not resolve the configured Chat adapter.")
  const chatOptions = getChannelChatOptions(agent, registration.channelId, baseChatOptions)
  const state = await resolveChatState(chatOptions, context, registration, options)
  await state.state.connect()
  const chat = await createChannelChat(agent, context, registration, adapterName!, adapter, chatOptions, options, undefined, state)
  const messages: Record<string, unknown>[] = []
  const attachmentBudget = { remaining: channelHistoryAttachmentMaxBytes }
  let archiveBytes = 0
  let completed = false
  let iterator: AsyncIterator<ChatSdkMessage> | undefined
  try {
    const historyIterator = chat.thread(body.threadId.trim()).allMessages[Symbol.asyncIterator]()
    iterator = historyIterator
    while (true) {
      const next = await boundedChannelHistoryOperation(() => historyIterator.next(), request.signal)
      if (!next || !isRuntimeObject(next) || !("done" in next)) throw new Error("Channel history provider returned an invalid result.")
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      const result = next as IteratorResult<ChatSdkMessage>
      if (result.done) {
        completed = true
        break
      }
      const message = result.value
      const archivedMessage = await channelHistoryMessage(message, adapter, attachmentBudget, request.signal)
      const messageBytes = boundedJsonByteLength(archivedMessage, channelHistoryArchiveMaxBytes - archiveBytes)
      if (messageBytes === undefined) throw new Error("Channel history archive exceeds the 35 MiB response limit.")
      archiveBytes += messageBytes
      messages.push(archivedMessage)
      if (request.signal.aborted) break
    }
  } catch (error) {
    return createJsonErrorResponse(400, error instanceof Error ? error.message : "Channel history export failed.")
  } finally {
    if (!completed && iterator?.return) {
      try {
        await boundedChannelHistoryOperation(() => iterator!.return!(), AbortSignal.timeout(30_000))
      } catch {}
    }
  }
  const configuredHistory = isRecord(chatOptions?.threadHistory) ? chatOptions.threadHistory : {}
  const archive = {
    agent: context.agentIdentity?.name || "agent",
    channel: registration.channelId || registration.id,
    exportedAt: new Date().toISOString(),
    messages,
    provider: registration.provider,
    retention: {
      maxMessages: configuredHistory.maxMessages ?? 100,
      ttlMs: configuredHistory.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
    },
    schemaVersion: 1,
    threadId: body.threadId.trim(),
  }
  const serialized = JSON.stringify(archive)
  if (boundedUtf8ByteLength(serialized, channelHistoryArchiveMaxBytes) === undefined) {
    return createJsonErrorResponse(400, "Channel history archive exceeds the 35 MiB response limit.")
  }
  return new Response(serialized, { headers: { "content-type": "application/json" } })
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
  state?: { state: StateAdapter; titleKeyPrefix: string },
  resolveDelivery?: () => Promise<AgentChannelDeliveryTracker>,
): Promise<(request: Request, webhookOptions: WebhookOptions) => Promise<Response>> {
  const chat = await createChannelChat(
    agent,
    context,
    registration,
    adapterName,
    adapter,
    options,
    handlerOptions,
    maximumInvocationDeadline,
    state,
    resolveDelivery,
  )
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

async function parseAgentChannelChatRouteBody(request: Request): Promise<{ body: AgentChannelChatRouteBody; rawBody: string }> {
  const raw = await request.text()
  if (!raw.trim()) throw createRouteBodyError("Missing agent chat payload.")
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || Array.isArray(parsed)) throw createRouteBodyError("Agent chat payload must be a JSON object.")
    // SAFETY: every named field is optional and consumers validate the string fields before use.
    const body = parsed as AgentChannelChatRouteBody
    return { body, rawBody: raw }
  } catch (error) {
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
  if (!isRuntimeString(value)) throw createRouteBodyError(`${label} must be a string when provided.`)
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
  // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
  return body as AgentChannelChatRouteBody & { messages: UIMessage[] }
}

async function parseAgentChannelChatRouteAdmissionBody<TBody extends AgentChannelChatRouteBody>(
  body: AgentChannelChatRouteBody,
  schema: AgentChannelChatRouteStandardSchemaV1<TBody> | undefined,
): Promise<TBody> {
  const validatedBody = validateAgentChannelChatRouteBody(body)
  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
  if (!schema) return validatedBody as TBody
  try {
    return await parseStandardSchema(schema, validatedBody, "agent chat route body")
  } catch (error) {
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
  if (
    !allowTrustedInput &&
    ("invoker" in body || "invokerProfileId" in body || "meta" in body || "run" in body || "session" in body || "timeout" in body || "user" in body)
  ) {
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
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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
  return Object.values(agent.channels).some((channel) => isRecord(channel) && channel.route !== undefined && channel.route !== false)
}

function resolveAgentChannelChatRouteHandlerOptions(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChannelChatRouteHandlerOptions = {},
): AgentChannelChatRouteHandlerOptions {
  const channels =
    // SAFETY: The surrounding route guards establish this record shape before the value crosses the internal boundary.
    isRecord(agent) && isRecord(agent.channels) && !Array.isArray(agent.channels) ? (agent.channels as Record<string, AgentChannelDefinition>) : {}
  const routeEntries = Object.entries(channels)
    .map(([channelId, channel]) => [channelId, agentChannelRouteOptions(channelId, channel)] as const)
    .filter((entry): entry is readonly [string, AgentChannelChatRouteHandlerOptions] => entry[1] !== undefined)

  if (routeEntries.length > 1) {
    throw new TypeError(
      "[vitehub] createChannelChatRouteHandler() found multiple route-enabled Channels. Keep one route-enabled Channel per generated chat route.",
    )
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
    else if (field === "session" && body.session !== undefined)
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      patch.session = optionalBodyRecord(body.session, "session") as AgentChatMessageTriggerInput["session"]
    else if (field === "timeout" && isRuntimeNumber(body.timeout) && Number.isFinite(body.timeout) && body.timeout > 0) patch.timeout = body.timeout
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
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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
  return isRecord(value) && isRuntimeString(value.id) && isRuntimeString(value.name) && isRuntimeString(value.toolCallId) && isRuntimeBoolean(value.approved)
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
  } finally {
    await state.releaseLock(lock)
  }
}

function uiApprovalPart(part: unknown): { approval: Record<string, unknown>; record: Record<string, unknown> } | undefined {
  if (!isRecord(part)) return
  const type = part.type
  if (type !== "dynamic-tool" && !(isRuntimeString(type) && type.startsWith("tool-"))) return
  if (part.state !== "approval-requested" && part.state !== "approval-responded") return
  if (!isRecord(part.approval) || !isRuntimeString(part.approval.id)) return
  return { approval: part.approval, record: part }
}

async function authorizeAgentChatApprovals(
  state: StateAdapter,
  invokerId: string,
  sessionId: string,
  messages: UIMessageLike[],
  persistApprovedTools = true,
  ttlMs = agentChatApprovalTtlMs,
): Promise<{ approvedTools: string[]; messages: UIMessageLike[] }> {
  const submitted = messages.flatMap((message, messageIndex) =>
    (message.parts || []).flatMap((part) => {
      const approvalPart = uiApprovalPart(part)
      return approvalPart ? [{ ...approvalPart, historical: messageIndex < messages.length - 1 }] : []
    }),
  )
  if (!submitted.length) return { approvedTools: [], messages }

  return await withAgentChatApprovalLock(state, invokerId, sessionId, async () => {
    const pending = new Map(
      await Promise.all(
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        [...new Set(submitted.map((part) => part.approval.id as string))].map(
          // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
          async (id) => [id, await state.get<AgentChatPendingApproval>(agentChatApprovalKey(invokerId, sessionId, id))] as const,
        ),
      ),
    )
    const historical = new Map(
      await Promise.all(
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        [...new Set(submitted.filter((part) => part.historical).map((part) => part.approval.id as string))].map(async (id) => {
          const value = await state.get<AgentChatConsumedApproval>(agentChatConsumedApprovalKey(invokerId, sessionId, id))
          // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
          return [id, isAgentChatConsumedApproval(value) ? value : undefined] as const
        }),
      ),
    )
    const consumed = new Set<string>()
    const authorized = messages
      .map((message, messageIndex) => ({
        ...message,
        parts: (message.parts || [])
          .filter((part) => {
            const submittedPart = uiApprovalPart(part)
            if (!submittedPart || messageIndex === messages.length - 1) return true
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            const id = submittedPart.approval.id as string
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            return Boolean(pending.get(id) || historical.get(id))
          })
          .map((part) => {
            const submittedPart = uiApprovalPart(part)
            if (!submittedPart) return part
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            const id = submittedPart.approval.id as string
            const historicalDecision = historical.get(id)
            const request = pending.get(id) ?? (messageIndex < messages.length - 1 ? historicalDecision : undefined)
            if (!request) throw createRouteBodyError(`Agent chat approval ${JSON.stringify(id)} was not issued by this session.`)
            if (submittedPart.record.state === "approval-responded") {
              if (!isRuntimeBoolean(submittedPart.approval.approved)) {
                throw createRouteBodyError(`Agent chat approval ${JSON.stringify(id)} requires an approved decision.`)
              }
              if (consumed.has(id)) throw createRouteBodyError(`Agent chat approval ${JSON.stringify(id)} was submitted more than once.`)
              consumed.add(id)
            }
            return {
              ...submittedPart.record,
              approval: {
                id,
                ...(isRuntimeBoolean(submittedPart.approval.approved) ? { approved: historicalDecision?.approved ?? submittedPart.approval.approved } : {}),
                ...(isRuntimeString(historicalDecision?.reason ?? submittedPart.approval.reason)
                  ? { reason: historicalDecision?.reason ?? submittedPart.approval.reason }
                  : {}),
              },
              input: request.input,
              toolCallId: request.toolCallId,
              toolName: request.name,
            }
          }),
      }))
      .filter((message) => message.parts.length > 0)

    const newlyApproved = submitted.flatMap((part) => {
      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      const id = part.approval.id as string
      const request = pending.get(id)
      return part.record.state === "approval-responded" && part.approval.approved === true && request ? [request.name] : []
    })
    if (persistApprovedTools && newlyApproved.length) {
      const approved = await state.get<string[]>(agentChatApprovedToolsKey(invokerId, sessionId))
      await state.set(agentChatApprovedToolsKey(invokerId, sessionId), [...new Set([...(approved ?? []), ...newlyApproved])], ttlMs)
    }
    await Promise.all(
      [...consumed].map(async (id) => {
        const request = pending.get(id)
        const decision = submitted.find((part) => part.approval.id === id && part.record.state === "approval-responded")?.approval
        if (request && isRuntimeBoolean(decision?.approved)) {
          await state.set(
            agentChatConsumedApprovalKey(invokerId, sessionId, id),
            {
              ...request,
              approved: decision.approved,
              ...(isRuntimeString(decision.reason) ? { reason: decision.reason } : {}),
            } satisfies AgentChatConsumedApproval,
            ttlMs,
          )
        }
      }),
    )
    await Promise.all([...consumed].map((id) => state.delete(agentChatApprovalKey(invokerId, sessionId, id))))
    return { approvedTools: [...new Set(newlyApproved)], messages: authorized }
  })
}

function trackAgentChatApprovals(result: unknown, state: StateAdapter, invokerId: string, sessionId: string, ttlMs = agentChatApprovalTtlMs): unknown {
  const toolInputs = new Map<string, { input?: unknown; name?: string }>()

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
            // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
            pending += decoder.decode(chunk.value as Uint8Array, { stream: true })
            const events = pending.split(/\r?\n\r?\n/)
            pending = events.pop() || ""
            for (const event of events) {
              const data = event
                .split(/\r?\n/)
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart())
                .join("\n")
              if (data && data !== "[DONE]") {
                try {
                  await trackChunk(JSON.parse(data))
                } catch (error) {
                  if (!(error instanceof SyntaxError)) throw error
                }
              }
            }
          } else await trackChunk(chunk.value)
          controller.enqueue(chunk.value)
        } catch (error) {
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
    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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

export function createChannelChatRouteHandler(
  agent: AgentInput<ViteAgentRouteRuntimeContext>,
  options: AgentChannelChatRouteHandlerOptions = {},
): AgentChannelChatRouteHandler {
  const routeOptions = resolveAgentChannelChatRouteHandlerOptions(agent, options)
  const handler: AgentChannelChatRouteHandler = async (request, handlerOptions = {}) => {
    if (request.method !== "POST") {
      return createJsonErrorResponse(405, "Agent chat route only accepts POST requests.")
    }

    let delivery: AgentChannelDeliveryTracker | undefined
    try {
      const parsed = await parseAgentChannelChatRouteBody(request)
      const agentIdentity = routeAgentIdentity(handlerOptions)
      const agentName = agentIdentity?.name || "agent"
      const auth = await routeOptions.admission?.authenticate?.({
        agentName,
        body: parsed.body,
        event: handlerOptions.event,
        rawBody: parsed.rawBody,
        request,
      })
      if (auth === false) throw createRouteError(401, "Agent chat route request was not admitted.")
      const body = await parseAgentChannelChatRouteAdmissionBody(parsed.body, routeOptions.admission?.body)
      let context = createRuntimeContext(
        createRuntimeRequest(request, parsed.rawBody),
        undefined,
        await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
        handlerOptions.cloudflare,
        handlerOptions.runtime,
        handlerOptions.capabilities,
        agentIdentity,
      )
      const trustInput = Boolean(routeOptions.admission?.authenticate && routeOptions.input?.trust?.length)
      const baseInput = agentChannelChatRouteInput(
        body,
        agentName,
        Boolean(trustInput || routeOptions.admission?.context || routeOptions.mapInput),
        routeOptions,
      )
      const trustedInput = mergeAgentChannelChatRouteInput(baseInput, trustInput ? trustAgentChannelChatRouteInput(body, routeOptions.input) : undefined)
      const inputContext = {
        agentName,
        // SAFETY: The route normalized this value for an internal boundary whose generic signature cannot express the narrowed variant.
        auth: auth as never,
        body,
        event: handlerOptions.event,
        input: trustedInput,
        rawBody: parsed.rawBody,
        request,
      }
      const admittedInput = mergeAgentChannelChatRouteInput(trustedInput, await routeOptions.admission?.context?.(inputContext))
      let triggerInput = mergeAgentChannelChatRouteInput(admittedInput, await routeOptions.mapInput?.({ ...inputContext, input: admittedInput }))
      const chatOptions = getChannelChatOptions(agent, routeOptions.channelId, getAgentChatOptions(agent)) || {}
      const invokerInput = createChatMessageTriggerInput(chatOptions, triggerInput).input
      const invoker = await resolveAgentInvoker(
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        (agent as AgentDefinition<ViteAgentRouteRuntimeConfig> | undefined)?.invoker,
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        context,
        createAgentInvocationContextStore(invokerInput.context),
        invokerInput,
        triggerInput.run,
      )
      triggerInput = {
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        ...(withResolvedAgentInvokerInput(triggerInput as never, invoker) as AgentChatMessageTriggerInput),
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        invoker,
      }
      const sessionId = triggerInput.run?.threadId ?? triggerInput.run?.runId
      let selectedSessionId = resolveChatSessionId(triggerInput.messages, chatOptions.sessions, triggerInput.session)
      const registration = {
        channelId: routeOptions.channelId || "http",
        id: routeOptions.channelId || "http",
        provider: routeOptions.origin || "http",
      }
      const { state } = await resolveChatState(chatOptions, context, registration, handlerOptions)
      await state.connect()
      delivery = await openAgentChannelDelivery(state, {
        agentName,
        channelId: registration.channelId,
        provider: registration.provider,
        scope: `chat:${agentName}:${registration.provider}:${encodeURIComponent(invoker.id)}:${sessionId || "default"}`,
        sourceId: agentChannelDeliverySourceValue(body.messageId) || agentChannelDeliverySourceValue(triggerInput.run?.messageId) || randomToken(),
      })
      context = withAgentChannelDelivery(context, delivery)
      const sessionOptions = chatOptions.sessions
      let approvalTtlMs = agentChatApprovalTtlMs
      const manualSessions =
        sessionOptions === true ||
        Boolean(
          sessionOptions &&
          (sessionOptions.strategy === "manual" || sessionOptions.strategy === "hybrid" || (!sessionOptions.strategy && !sessionOptions.idleTimeoutMs)),
        )
      if (sessionId && manualSessions) {
        const manualId = resolveChatSessionBaseId(triggerInput.messages, chatOptions.sessions, triggerInput.session) || "default"
        const boundaryKey = agentChatSessionBoundaryKey(invoker.id, sessionId, manualId)
        approvalTtlMs =
          sessionOptions && sessionOptions !== true && sessionOptions.strategy === "hybrid" && sessionOptions.idleTimeoutMs
            ? Math.min(agentChatApprovalTtlMs, sessionOptions.idleTimeoutMs)
            : agentChatApprovalTtlMs
        if (triggerInput.session?.action === "new") {
          selectedSessionId = `${manualId}:manual:${randomToken()}`
        } else {
          selectedSessionId = (await state.get<string>(boundaryKey)) || selectedSessionId
        }
        if (selectedSessionId) await state.set(boundaryKey, selectedSessionId, approvalTtlMs)
      }
      const approvalSessionId = sessionId && selectedSessionId ? `${sessionId}:chat-session:${selectedSessionId}` : sessionId
      if (approvalSessionId) {
        triggerInput = {
          ...triggerInput,
          context: {
            ...triggerInput.context,
            "chat.sessionId": approvalSessionId,
          },
        }
      }
      if (approvalSessionId) {
        const persistApprovedTools = invoker.kind !== "anonymous"
        if (
          !persistApprovedTools &&
          triggerInput.messages.some((message) => message.parts?.some((part) => uiApprovalPart(part)?.record.state === "approval-responded"))
        ) {
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
      await recordChannelDeliveryEvidence(delivery, {
        type: "accepted",
        runId: triggerInput.run?.runId,
      })
      await recordChannelDeliveryEvidence(delivery, {
        type: "invocation.started",
        runId: triggerInput.run?.runId,
      })
      let result = await runWithRuntimeCloudflareEnv(
        context,
        async () =>
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          await streamAgentTrigger(agent as never, context as never, "chat.message", triggerInput, {
            output: "ui-message-stream",
          }),
      )
      if (approvalSessionId) result = trackAgentChatApprovals(result, state, invoker.id, approvalSessionId, approvalTtlMs)
      return await observeChannelDeliveryResponse(await toAgentChatFetchResponse(result), delivery, triggerInput.run?.runId)
    } catch (error) {
      if (delivery) {
        await settleChannelDeliveryInvocation(delivery, "failed", "failed", {
          error: channelDeliveryError(error),
        })
      }
      return agentChatFetchErrorResponse(error)
    }
  }
  handler.deliveries = async (request, handlerOptions = {}) => {
    const context = createRuntimeContext(
      request,
      undefined,
      await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
      handlerOptions.cloudflare,
      handlerOptions.runtime,
      handlerOptions.capabilities,
      routeAgentIdentity(handlerOptions),
    )
    const agentName = context.agentIdentity?.name || "agent"
    const registration = {
      channelId: routeOptions.channelId || "http",
      id: routeOptions.channelId || "http",
      provider: routeOptions.origin || "http",
    }
    const chatOptions = getChannelChatOptions(agent, routeOptions.channelId, getAgentChatOptions(agent)) || {}
    const { state } = await resolveChatState(chatOptions, context, registration, handlerOptions)
    await state.connect()
    return await readAgentChannelDeliveries(state, handlerOptions.limit, `chat:${agentName}:${registration.provider}:`)
  }
  return handler
}

export function createChannelWebhookRouteHandler(agent: AgentInput<ViteAgentRouteRuntimeContext>): AgentChannelWebhookRouteHandler {
  const queueScopes = new Map<
    string,
    {
      backendId: string
      options: AgentChannelWebhookRouteOptions
      scope: string
      state: AgentWebhookQueueStateAdapter
    }
  >()
  const queueStates = new Map<AgentWebhookQueueStateAdapter, Map<string, string> | undefined>()
  const drainingScopes = new Set<string>()
  const pendingDrainScopes = new Set<string>()
  const retryTimers = new Map<string, { at: number; resolve: () => void; timer: ReturnType<typeof setTimeout> }>()
  const activeDeliveries = new Map<Promise<number | undefined>, { controller: AbortController; scope: string }>()
  const inFlightDrains = new Set<Promise<void>>()
  const activeInvocationScope: WebhookActiveInvocationScope = { owner: "webhook" }
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
    const scheduled = new Promise<void>((resolve) => {
      resolveScheduled = resolve
    })
    const timer = setTimeout(
      () => {
        retryTimers.delete(queueId)
        void drainQueue(queueId).finally(resolveScheduled)
      },
      Math.max(0, at - Date.now()),
    )
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
          if (![...activeDeliveries.values()].some((active) => active.scope === queueId)) {
            scheduleQueueDrain(queueId, Date.now() + defaultWebhookQueueRetryMs)
          }
          break
        }
        if (queueStopped) {
          await queue.state
            .retryWebhookDelivery(queue.scope, delivery.deliveryId, delivery.leaseToken, Date.now(), { incrementAttempts: false })
            .catch(() => undefined)
          break
        }
        const controller = new AbortController()
        const task = executeQueuedWebhookDelivery(agent, queue.state, activeInvocationScope, queue.backendId, delivery, queue.options, controller.signal)
        activeDeliveries.set(task, { controller, scope: queueId })
        waitUntil?.(task)
        void task
          .then((retryAt) => {
            for (const registeredQueueId of queueScopes.keys()) {
              if (registeredQueueId !== queueId) void drainQueue(registeredQueueId)
            }
            if (retryAt === undefined || retryAt <= Date.now()) void drainQueue(queueId)
            else scheduleQueueDrain(queueId, retryAt, waitUntil)
          })
          .catch((error) => {
            console.error(`[vitehub] Queued webhook delivery "${delivery.deliveryId}" stopped unexpectedly.`, error)
            scheduleQueueDrain(queueId, Date.now() + defaultWebhookQueueRetryMs, waitUntil)
          })
          .finally(() => {
            activeDeliveries.delete(task)
          })
      }
    } catch (error) {
      console.error("[vitehub] Webhook queue drain failed and will be retried.", error)
      scheduleQueueDrain(queueId, Date.now() + defaultWebhookQueueRetryMs, await resolveRuntimeWaitUntil(queue.options.waitUntil))
    } finally {
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
    let context = createRuntimeContext(
      request,
      undefined,
      waitUntil,
      handlerOptions.cloudflare,
      handlerOptions.runtime,
      handlerOptions.capabilities,
      routeAgentIdentity(handlerOptions),
    )
    // Cloudflare cancels waitUntil after 30 seconds, so the final two seconds stay available for cleanup and fallback delivery.
    const maximumInvocationDeadline =
      context.runtime === "cloudflare-agents" && handlerOptions.waitUntil ? webhookStartedAt + cloudflareChatInvocationTimeoutMs : undefined
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
      if (request.headers.get(agentChannelHistoryHeader) === "1") {
        const secret = await resolveMaybe(registration.secretToken, context)
        if (!registration.secretHeader || !secret) {
          return createJsonErrorResponse(403, "Channel history export requires a configured webhook secret.")
        }
        try {
          await verifyAgentWebhookRequest([registration], request, context, {
            requireSecretHeader: true,
          })
        } catch (error) {
          const response = toHttpErrorResponse(error)
          if (response) return response
          throw error
        }
        return await createChannelHistoryResponse(agent, context, registration, handlerOptions, request)
      }
      if (await matchedWebhookRegistrationRequiresVerification(registration, context, trigger.id !== "chat.message")) {
        try {
          await verifyAgentWebhookRequest([registration], request, context, {
            requireSecretHeader: true,
          })
        } catch (error) {
          const response = toHttpErrorResponse(error)
          if (response) return response
          throw error
        }
      }
      const webhookDeliveryState = await resolveAgentWebhookState(context, registration, handlerOptions)
      const chatOptions = getChannelChatOptions(agent, registration.channelId, getAgentChatOptions(agent))
      const workflowCustody = await hasActiveWorkflowRuntime(agent, context)
      const chatDeliveryState =
        trigger.id === "chat.message" || workflowCustody || !webhookDeliveryState
          ? {
              ...(await resolveChatState(chatOptions, context, registration, handlerOptions)),
              workflowCustodySupported: stateResolverSupportsWorkflowCustody(chatOptions?.state ?? handlerOptions.state),
            }
          : undefined
      const deliveryState =
        (trigger.id === "chat.message" ? undefined : workflowCustody ? undefined : webhookDeliveryState) ||
        (chatDeliveryState ? { keyPrefix: chatDeliveryState.titleKeyPrefix, state: chatDeliveryState.state } : undefined)
      if (!deliveryState) throw new Error("[vitehub] Agent Channel delivery state did not resolve.")
      await deliveryState.state.connect()
      const webhookPayload = parseWebhookPayload(await request.clone().text())
      const messageIdentity = agentChannelDeliveryMessageIdentity(registration.provider, webhookPayload)
      const payloadFingerprint = await agentChannelDeliveryPayloadFingerprint(webhookPayload)
      let channelDeliveryPromise: Promise<AgentChannelDeliveryTracker> | undefined
      const resolveChannelDelivery = async () => {
        channelDeliveryPromise ??= (async () => {
          const delivery = await openAgentChannelDelivery(deliveryState.state, {
            agentName: context.agentIdentity?.name || "agent",
            channelId: registration.channelId,
            provider: registration.provider,
            scope: deliveryState.keyPrefix || `channel:${context.agentIdentity?.name || "agent"}:${chatRegistrationOrigin(registration)}`,
            sourceId: await webhookDeliverySourceId(request, registration.provider, webhookPayload),
          })
          if (messageIdentity) {
            await bindAgentChannelDeliveryMessage(
              deliveryState.state,
              delivery,
              chatRegistrationOrigin(registration),
              messageIdentity.threadId,
              messageIdentity.messageId,
            ).catch((error) => logChannelDeliveryAliasFailure(delivery, "message", error))
          }
          if (payloadFingerprint) {
            await bindAgentChannelDeliveryPayload(deliveryState.state, delivery, chatRegistrationOrigin(registration), payloadFingerprint).catch((error) =>
              logChannelDeliveryAliasFailure(delivery, "payload", error),
            )
          }
          return delivery
        })()
        return await channelDeliveryPromise
      }

      if (trigger.id !== "chat.message") {
        const channelDelivery = await resolveChannelDelivery()
        context = withAgentChannelDelivery(context, channelDelivery)
        try {
          const input = await createAgentWebhookTriggerInput(request, registration)
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          const invocation = await resolveAgentTriggerInvocation(agent as never, context as never, trigger.id, input)
          if (isResolvedAgentTriggerHandledInvocation(invocation)) {
            await recordChannelDeliveryEvidence(channelDelivery, { type: "accepted" })
            await context.flushWaitUntil?.()
            return await observeHandledChannelDeliveryResponse(invocation.response, channelDelivery)
          }
          if (invocation.webhook?.busy === "steer" && (invocation.webhook.concurrencyKey === undefined || invocation.webhook.concurrencyLimit === undefined)) {
            return await terminalChannelDeliveryResponse(
              channelDelivery,
              createJsonErrorResponse(500, 'Webhook busy: "steer" requires concurrencyKey and concurrencyLimit.'),
            )
          }
          if (
            (invocation.webhook?.concurrencyKey !== undefined || invocation.webhook?.concurrencyLimit !== undefined) &&
            (await hasActiveWorkflowRuntime(agent, context))
          ) {
            return await terminalChannelDeliveryResponse(
              channelDelivery,
              createJsonErrorResponse(503, "Webhook concurrency ownership requires inline Agent execution."),
            )
          }
          const webhookState = invocation.webhook ? webhookDeliveryState : undefined
          if (invocation.webhook && !webhookState) {
            return await terminalChannelDeliveryResponse(
              channelDelivery,
              createJsonErrorResponse(503, "Durable Agent state is required for webhook delivery ownership."),
            )
          }
          if (invocation.webhook?.concurrencyLimit !== undefined && webhookState) {
            const { concurrencyKey, deliveryId } = invocation.webhook
            if (!deliveryId.trim()) {
              return await terminalChannelDeliveryResponse(
                channelDelivery,
                createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty deliveryId."),
              )
            }
            if (concurrencyKey !== undefined && !concurrencyKey.trim()) {
              return await terminalChannelDeliveryResponse(
                channelDelivery,
                createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty concurrencyKey when configured."),
              )
            }
            const concurrencyLimit = positiveWebhookConcurrencyLimit(invocation.webhook.concurrencyLimit)!
            if (!hasAgentWebhookQueue(webhookState.state)) {
              return await terminalChannelDeliveryResponse(
                channelDelivery,
                createJsonErrorResponse(503, "Persistent webhook concurrency requires a queue-capable Agent state provider."),
              )
            }
            const backendId = await resolveWebhookStateBackendId(webhookState.state)
            const persistedInvocation = persistedWebhookInvocation({ input: invocation.input, run: invocation.run })
            const delivery = persistedWebhookRequest(
              deliveryId,
              channelDelivery.delivery.id,
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
              const outcome = await steerQueuedWebhookDelivery(
                webhookQueueState,
                activeInvocationScope,
                backendId,
                delivery,
                invocation.input,
                waitUntil,
                async (reserved) => {
                  if (reserved)
                    return Response.json({
                      accepted: true,
                      duplicate: false,
                      ok: true,
                      queued: true,
                    })
                  const queued = await webhookQueueState.enqueueWebhookDelivery(delivery)
                  return Response.json({ accepted: queued, duplicate: !queued, ok: true, queued })
                },
              )
              if (outcome) {
                if (outcome.queued) registerQueue(backendId, webhookState.keyPrefix, webhookQueueState, handlerOptions)
                if (outcome.settlement) {
                  await recordChannelDeliveryEvidence(channelDelivery, {
                    type: "queued",
                    runId: invocation.run?.runId,
                  })
                  context.waitUntil(
                    outcome.settlement.then(async (completed) => {
                      await recordChannelDeliveryEvidence(
                        channelDelivery,
                        completed ? { type: "completed", runId: invocation.run?.runId } : { type: "retrying", runId: invocation.run?.runId },
                      )
                    }),
                  )
                } else
                  await recordChannelDeliveryEvidence(channelDelivery, {
                    type: outcome.queued ? "queued" : outcome.response.ok ? "completed" : "rejected",
                    runId: invocation.run?.runId,
                  })
                if (outcome.queued || outcome.settlement) detachAgentChannelDelivery(channelDelivery)
                return outcome.response
              }
            }
            const queued = await webhookState.state.enqueueWebhookDelivery(delivery)
            await registerQueue(backendId, webhookState.keyPrefix, webhookState.state, handlerOptions)
            if (queued) detachAgentChannelDelivery(channelDelivery)
            await recordChannelDeliveryEvidence(channelDelivery, {
              type: queued ? "queued" : "duplicate",
              runId: invocation.run?.runId,
            })
            return Response.json({ accepted: queued, duplicate: !queued, ok: true, queued })
          }
          let webhookLock: Lock | null = null
          let deliveryClaimKey: string | undefined
          let concurrencyTtlMs = defaultWebhookConcurrencyTtlMs
          if (invocation.webhook && webhookState) {
            const { concurrencyKey, deliveryId } = invocation.webhook
            if (!deliveryId.trim()) {
              return await terminalChannelDeliveryResponse(
                channelDelivery,
                createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty deliveryId."),
              )
            }
            if (concurrencyKey !== undefined && !concurrencyKey.trim()) {
              return await terminalChannelDeliveryResponse(
                channelDelivery,
                createJsonErrorResponse(500, "Webhook delivery ownership requires a non-empty concurrencyKey when configured."),
              )
            }
            concurrencyTtlMs = positiveWebhookDuration(invocation.webhook.concurrencyTtlMs, defaultWebhookConcurrencyTtlMs, "concurrencyTtlMs")
            deliveryClaimKey = webhookOwnershipKey(webhookState.keyPrefix, "delivery", deliveryId)
            if ((await webhookState.state.get(deliveryClaimKey)) === true) {
              await channelDelivery.event({ type: "duplicate", runId: invocation.run?.runId })
              return Response.json({ accepted: false, duplicate: true, ok: true })
            }
            if (concurrencyKey !== undefined) {
              webhookLock = await webhookState.state.acquireLock(webhookOwnershipKey(webhookState.keyPrefix, "lease", concurrencyKey), concurrencyTtlMs)
              if (!webhookLock) {
                return await terminalChannelDeliveryResponse(channelDelivery, Response.json({ accepted: false, busy: true, ok: true }, { status: 503 }))
              }
            }
            let claimed: boolean
            try {
              claimed = await webhookState.state.setIfNotExists(deliveryClaimKey, true)
            } catch (error) {
              if (webhookLock) await webhookState.state.releaseLock(webhookLock)
              throw error
            }
            if (!claimed) {
              if (webhookLock) await webhookState.state.releaseLock(webhookLock)
              await channelDelivery.event({ type: "duplicate", runId: invocation.run?.runId })
              return Response.json({ accepted: false, duplicate: true, ok: true })
            }
          }
          const runContext = withAgentChannelDelivery(
            createRuntimeContext(
              request,
              invocation.run,
              waitUntil,
              handlerOptions.cloudflare,
              handlerOptions.runtime,
              handlerOptions.capabilities,
              routeAgentIdentity(handlerOptions),
            ),
            channelDelivery,
          )
          await recordChannelDeliveryEvidence(channelDelivery, {
            type: "accepted",
            runId: invocation.run?.runId,
          })
          await recordChannelDeliveryEvidence(channelDelivery, {
            type: "invocation.started",
            runId: invocation.run?.runId,
          })
          const ownershipAbort = webhookLock ? new AbortController() : undefined
          let stopHeartbeat: (() => void) | undefined
          if (webhookLock && webhookState && ownershipAbort) {
            stopHeartbeat = startWebhookLockHeartbeat(webhookState.state, webhookLock, concurrencyTtlMs, () => {
              ownershipAbort.abort(new Error("[vitehub] Webhook concurrency ownership was lost during Agent execution."))
            })
          }
          let dispatch!: (accepted: boolean) => void
          const dispatchGate = new Promise<boolean>((resolve) => {
            dispatch = resolve
          })
          const task = dispatchGate.then(async (accepted) => {
            if (!accepted) return
            try {
              let durableHandoff = false
              await runWithRuntimeCloudflareEnv(runContext, async () => {
                try {
                  const result = await runAgent(
                    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                    agent as never,
                    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                    runContext as never,
                    // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                    {
                      ...invocation.input,
                      context: {
                        ...invocation.input.context,
                        [agentChannelDeliveryWorkflowContextKey]: {
                          channelId: registration.channelId,
                          deliveryId: channelDelivery.delivery.id,
                          provider: registration.provider,
                          state: workflowCustody ? "chat" : webhookDeliveryState ? "webhook" : "chat",
                        },
                      },
                      ...(ownershipAbort
                        ? {
                            abortSignal: invocation.input.abortSignal
                              ? AbortSignal.any([invocation.input.abortSignal, ownershipAbort.signal])
                              : ownershipAbort.signal,
                          }
                        : {}),
                    } as never,
                  )
                  if (!isWorkflowRun(result) || result.status === "completed") {
                    await runContext.flushWaitUntil?.()
                  } else if (result.status === "queued" || result.status === "running") {
                    durableHandoff = true
                    await recordChannelDeliveryEvidence(channelDelivery, {
                      type: "queued",
                      runId: invocation.run?.runId,
                    })
                    detachAgentChannelDelivery(channelDelivery)
                  } else {
                    throw new Error(isRuntimeString(result.metadata) ? result.metadata : `Agent Workflow returned ${result.status}.`)
                  }
                } finally {
                  stopHeartbeat?.()
                  if (webhookLock && webhookState) {
                    await webhookState.state.releaseLock(webhookLock)
                  }
                }
              })
              if (durableHandoff) return
              await settleChannelDeliveryInvocation(channelDelivery, "completed", "completed", {
                runId: invocation.run?.runId,
              })
            } catch (error) {
              await settleChannelDeliveryInvocation(channelDelivery, "failed", "failed", {
                error: channelDeliveryError(error),
                runId: invocation.run?.runId,
              })
              throw error
            }
          })
          try {
            context.waitUntil(task)
            dispatch(true)
          } catch (error) {
            dispatch(false)
            stopHeartbeat?.()
            if (webhookLock && webhookState) await webhookState.state.releaseLock(webhookLock)
            if (deliveryClaimKey && webhookState) await webhookState.state.delete(deliveryClaimKey)
            throw error
          }
          return Response.json({ accepted: true, ok: true })
        } catch (error) {
          await channelDelivery.event({ error: channelDeliveryError(error), type: "failed" })
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
          return await terminalChannelDeliveryResponse(
            await resolveChannelDelivery(),
            createJsonErrorResponse(500, `Agent chat webhook "${webhookId}" does not have a matching chat adapter.`),
          )
        }

        try {
          const chatOptions = getChannelChatOptions(agent, registration.channelId, baseChatOptions)
          const handler = await createChatWebhookHandler(
            agent,
            context,
            registration,
            adapterName!,
            adapter,
            chatOptions,
            handlerOptions,
            maximumInvocationDeadline,
            chatDeliveryState,
            resolveChannelDelivery,
          )
          webhookDeadlineAbort?.signal.throwIfAborted()
          const response = await handler(request, { waitUntil: context.waitUntil })
          if (response.status === 401 || response.status === 403) return response
          const channelDelivery = await resolveChannelDelivery()
          if (!channelDelivery.claimed && !channelDelivery.duplicate) {
            const serial = chatSdkOption<string>(chatOptions, "concurrency") === "serial"
            const ignored =
              serial &&
              response.ok &&
              (await response
                .clone()
                .json()
                .then((body) => isRecord(body) && body.ignored === true)
                .catch(() => false))
            await recordChannelDeliveryEvidence(channelDelivery, {
              // Chat SDK may evict or expire serial entries without exposing
              // their identity. Record transport acceptance until a drain
              // claims this delivery instead of promising durable queue custody.
              type: response.ok ? (serial && !ignored ? "accepted" : "completed") : response.status >= 500 ? "failed" : "rejected",
            })
            if (serial && !ignored && response.ok) detachAgentChannelDelivery(channelDelivery)
          }
          if (chatOptions?.stream === false && hasExplicitNonStreamingMessages(agent, registration.channelId)) {
            await context.flushWaitUntil?.()
          }
          return response
        } catch (error) {
          const response = toHttpErrorResponse(error)
          if (response?.status === 401 || response?.status === 403) return response
          const channelDelivery = await resolveChannelDelivery()
          if (!channelDelivery.duplicate) await channelDelivery.event({ error: channelDeliveryError(error), type: "failed" })
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
  handler.deliveries = async (request, webhook, handlerOptions = {}) => {
    const webhookId = webhook === undefined ? fallbackWebhookFromRequest(request) : webhook
    if (webhookId === undefined) return []
    const context = createRuntimeContext(
      request,
      undefined,
      await resolveRuntimeWaitUntil(handlerOptions.waitUntil),
      handlerOptions.cloudflare,
      handlerOptions.runtime,
      handlerOptions.capabilities,
      routeAgentIdentity(handlerOptions),
    )
    const match = await findAgentWebhookRegistration(agent, context, request, webhookId)
    if (!match) return []
    const webhookState = await resolveAgentWebhookState(context, match.registration, handlerOptions)
    const chatState = await resolveChatState(
      getChannelChatOptions(agent, match.registration.channelId, getAgentChatOptions(agent)),
      context,
      match.registration,
      handlerOptions,
    )
    const workflowChatState = await resolveChatState(
      getChannelChatOptions(agent, match.registration.channelId, getAgentChatOptions(agent)),
      context,
      match.registration,
      {},
    )
    const fallbackScope = `channel:${context.agentIdentity?.name || "agent"}:${chatRegistrationOrigin(match.registration)}`
    const sources = [
      webhookState && { scope: webhookState.keyPrefix, state: webhookState.state },
      { scope: chatState.titleKeyPrefix || fallbackScope, state: chatState.state },
      { scope: workflowChatState.titleKeyPrefix || fallbackScope, state: workflowChatState.state },
    ].filter((source): source is { scope: string; state: StateAdapter } => Boolean(source))
    const inspections = (
      await Promise.all(
        sources.map(async ({ scope, state }) => {
          await state.connect()
          return await readAgentChannelDeliveries(state, handlerOptions.limit, scope)
        }),
      )
    ).flat()
    return [...new Map(inspections.map((delivery) => [delivery.id, delivery])).values()]
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, handlerOptions.limit ?? 100)
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
          } else {
            const backendId = await resolveWebhookStateBackendId(state)
            for (const scope of persistedScopes) {
              if (scope.startsWith(agentScopePrefix)) await registerQueue(backendId, scope, state, handlerOptions)
            }
          }
        }
      })()
        .catch((error) => console.error("[vitehub] Webhook queue scope discovery failed and will be retried.", error))
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
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
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
        .catch((error) => console.error("[vitehub] Webhook queue startup discovery failed and will be retried.", error))
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
  if (!isRuntimeFunction(initialize)) {
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
      const entries = Object.entries(channels).filter(
        (entry): entry is [string, AgentChannelDefinition] =>
          isRecord(entry[1]) &&
          entry[1].kind === "telegram" &&
          entry[1].listener?.kind === "telegram-polling" &&
          entry[1].messages !== false &&
          entry[1].adapter !== undefined,
      )
      if (entries.length === 0) {
        return createJsonErrorResponse(500, "Telegram polling route requires a polling Telegram Channel.")
      }

      // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      let chats = telegramPollingChats.get(agent as object)
      if (!chats) {
        chats = new Map()
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
        telegramPollingChats.set(agent as object, chats)
        // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
      }
      const chatOptions = getAgentChatOptions(agent)
      await Promise.all(
        entries.map(async ([channelId, channel]) => {
          let chat = chats!.get(channelId)
          if (!chat) {
            chat = (async () => {
              logChannelListener("started", "telegram", channelId)
              try {
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
                  // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
                  adapter as Adapter,
                  getChannelChatOptions(agent, channelId, chatOptions),
                  handlerOptions,
                )
                await startChannelChat(instance)
                logChannelListener("completed", "telegram", channelId)
                return instance
              } catch (error) {
                logChannelListener("failed", "telegram", channelId, {
                  error: channelDeliveryError(error),
                })
                throw error
              }
            })()
            chats!.set(channelId, chat)
            chat.catch(() => chats!.delete(channelId))
          }
          await chat
        }),
      )
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
          const startGatewayListener: unknown = Reflect.get(adapter, "startGatewayListener")
          if (!isRuntimeFunction(startGatewayListener)) {
            return createJsonErrorResponse(500, `Discord chat adapter "${adapterName}" does not expose startGatewayListener().`)
          }

          const registration = (await resolveDiscordWebhookRegistration(agent, context, adapters, adapterName)) || {
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
          // SAFETY: The owning Agent runtime boundary creates this value with the asserted route contract.
          await (chat as { initialize?: () => Promise<void> }).initialize?.()
          chats.push(chat)
          const webhookId = registration.id || adapterName
          const webhookUrl = isRuntimeFunction(handlerOptions.webhookUrl) ? handlerOptions.webhookUrl(webhookId) : handlerOptions.webhookUrl

          logChannelListener("started", "discord", adapterName)
          responsePromises.push(
            startGatewayListener
              .call(adapter, { waitUntil: context.waitUntil }, handlerOptions.durationMs, handlerOptions.abortSignal, webhookUrl)
              .then((response: Response) => {
                logChannelListener(response.ok ? "completed" : "failed", "discord", adapterName, {
                  status: response.status,
                })
                return response
              })
              .catch((error: unknown) => {
                logChannelListener("failed", "discord", adapterName, {
                  error: channelDeliveryError(error),
                })
                throw error
              }),
          )
        }

        const responses = await Promise.all(responsePromises)
        if (!handlerOptions.webhookUrl) await context.flushWaitUntil?.()
        if (responses.length === 1) return responses[0]!
        const failed = responses.find((response) => !response.ok)
        if (failed) return failed
        return Response.json({ gateways: responses.length, ok: true })
      } finally {
        if (!handlerOptions.webhookUrl) {
          await Promise.allSettled(chats.map((chat) => chat.shutdown()))
        }
      }
    })
  }
}
