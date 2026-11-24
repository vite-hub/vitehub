import { isResponse } from "./internal/response.ts"
import { channelWebhookEventTarget } from "./internal/channel-webhook-events.ts"
import {
  channelDeliveryEffectsContextKey,
  channelDeliveryFinishEffectsContextKey,
  normalizeCapabilities,
} from "./capability-runtime.ts"
import { agentHttpError, type AgentHttpError } from "./http-error.ts"
import { isRuntimeRecord } from "./internal/runtime-type.ts"
import { runInvocationReference } from "./invocations.ts"
import { agentInvocationName } from "./internal/agent-invocation-name.ts"

import type {
  AgentCallbackContext,
  AgentCapabilityDefinition,
  AgentChannelDefinition,
  AgentChannelTriggerContext,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentChannelDispatchItem,
  AgentChannelDispatchOptions,
  AgentChannelPullOptions,
  AgentChannelStateBinding,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentTriggerAcceptedInvocation,
  AgentTriggerDefinition,
  AgentTriggerInvokeResult,
  AgentTriggerPrepareResult,
  AgentTriggerRunInvokeResult,
  AgentWebhookInvocationOwnership,
  AgentWebhookRegistrationDefinition,
  MaybePromise,
  ResolvedAgentRuntimeContext,
  ResolvedAgentTriggerDefinition,
  ResolvedAgentTriggerTask,
} from "./types.ts"
import { parseStandardSchema } from "@vite-hub/internal/http-request"
import { parseDuration } from "@vite-hub/runtime"
import { serverVariable } from "./internal/server-variable.ts"
import { githubHmacSignatureFormat, stripeSignatureToleranceSeconds, verifyViteHubHmacSignature, verifyViteHubStripeSignature } from "@vite-hub/internal/secret"
import { agentChannelTriggerQueue, channelMessageContextKey } from "./internal/channel-delivery-handlers.ts"
import { agentCapabilityOptions, agentChannelOptions, hasAgentDefinition } from "./internal/agent-definition-options.ts"
import type { StreamEvent } from "./messages.ts"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { WorkspaceName } from "@vite-hub/workspace"
import { agentDiagnostics } from "./agent-diagnostics.ts"
import { createAgentChannelState, pullAgentChannel } from "./internal/channel-state.ts"
import type { AgentChannelStateCommit } from "./internal/channel-state.ts"
import type { ReplayChannelResult } from "./channel-replay.ts"

export function isTriggerInputSchema<TInput>(input: string | StandardSchemaV1<unknown, TInput> | undefined): input is StandardSchemaV1<unknown, TInput> {
  if (!isRuntimeRecord(input) && typeof input !== "function") return false
  if (!Object.hasOwn(input, "~standard")) {
    let prototype = Object.getPrototypeOf(input)
    let classGetterFound = false
    while (prototype !== null && prototype !== Object.prototype) {
      const marker = Object.getOwnPropertyDescriptor(prototype, "~standard")
      if (marker) {
        const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
        classGetterFound = typeof marker.get === "function"
          && typeof constructor === "function"
          && constructor !== Object
          && constructor.prototype === prototype
        break
      }
      prototype = Object.getPrototypeOf(prototype)
    }
    if (!classGetterFound) return false
  }
  // SAFETY: The runtime checks above establish an object or function with a validated marker location; its value remains unknown until validated below.
  const standard = (input as Record<PropertyKey, unknown>)["~standard"]
  return isRuntimeRecord(standard) && typeof standard.validate === "function"
}

const agentTriggerContextKey = "agent.trigger"

function createAgentCallbackContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
) {
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = context
  return callbackContext
}

function channelHistoryAnnotations<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  trigger: Pick<ResolvedAgentTriggerDefinition, "channelId" | "name">,
  input: unknown,
): AgentRunMetadata["annotations"] | undefined {
  if (!trigger.channelId) return
  const history = agentChannelOptions(agent)[trigger.channelId]?.history
  if (!history || (history.trigger !== undefined && history.trigger !== trigger.name)) return
  const annotations: NonNullable<AgentRunMetadata["annotations"]> = {}
  try {
    const key = history.key(input)
    if (typeof key === "string" && key.trim()) annotations["vitehub.channel.key"] = key
  }
  catch {}
  if (history.thread) {
    try {
      const thread = history.thread(input)
      if (typeof thread === "string" && thread.trim()) annotations["vitehub.channel.thread"] = thread
    }
    catch {}
  }
  return Object.keys(annotations).length ? annotations : undefined
}

const channelTriggerStates = new WeakMap<Request, { binding: AgentChannelStateBinding, channelId: string }>()

/** Gives the triggers of one Channel its State Adapter for the lifetime of a webhook request. */
export function bindAgentChannelTriggerState(request: Request, channelId: string, binding: AgentChannelStateBinding): void {
  channelTriggerStates.set(request, { binding, channelId })
}

function agentChannelTriggerState(request: Request | undefined, channelId: string): AgentChannelStateBinding | undefined {
  const bound = request ? channelTriggerStates.get(request) : undefined
  return bound?.channelId === channelId ? bound.binding : undefined
}

async function queueAgentChannelItems<TRuntimeConfig extends AgentRuntimeConfig>(
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  channelId: string,
  items: readonly AgentChannelDispatchItem[],
  options: AgentChannelDispatchOptions,
): Promise<ReplayChannelResult> {
  if (options.dryRun) throw agentDiagnostics.AGENT_DISPATCH_DRY_RUN_WITH_QUEUE({ channelId })
  const admit = agentChannelTriggerQueue(context.request, channelId)
  if (!admit) {
    throw agentDiagnostics.AGENT_DISPATCH_QUEUE_UNAVAILABLE({ channelId })
  }
  // SAFETY: The queue admits items with the runtime context of the trigger that called dispatch().
  return await admit(context as ResolvedAgentRuntimeContext, items, options)
}

async function dispatchAgentChannelItems<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  channelId: string,
  items: readonly AgentChannelDispatchItem[],
  options: AgentChannelDispatchOptions,
) {
  // Loaded on use: Channel replay depends on the Agent runner, which depends on this module.
  const { dispatchChannelItems } = await import("./channel-replay.ts")
  return await dispatchChannelItems(agent, context, channelId, items, options)
}

function assertTriggerName(name: unknown, owner: string): asserts name is string {
  if (typeof name !== "string" || !name.trim()) {
    throw agentDiagnostics.AGENT_R0868({ message: `[vitehub] ${owner} trigger names must be non-empty strings.` })
  }
  if (!/^[a-z][a-z0-9-_]*$/i.test(name)) {
    throw agentDiagnostics.AGENT_R0869({ message: `[vitehub] ${owner} trigger "${name}" must be a stable local identifier.` })
  }
}

function normalizeChannelWebhookRegistrations<TRuntimeConfig extends AgentRuntimeConfig>(
  channelId: string,
  kind: string,
  input: AgentChannelDefinition<TRuntimeConfig>["webhooks"],
) {
  if (input === undefined) return undefined
  if (input === false) return []
  const registrations = input === true ? [{}] : Array.isArray(input) ? input : [input]
  return registrations.map((registration, index) => ({
    ...registration,
    adapter: registration.adapter || channelId,
    channelId: registration.channelId || channelId,
    id: registration.id || (registrations.length > 1 ? `${channelId}-${index + 1}` : channelId),
    method: registration.method || "POST",
    provider: registration.provider || kind,
  }))
}

function capabilityWebhookTriggerForChannel<TRuntimeConfig extends AgentRuntimeConfig>(
  triggers: Record<string, ResolvedAgentTriggerDefinition<TRuntimeConfig>>,
  channelId: string,
  kind: string,
) {
  return triggers[`${channelId}.webhook`] || (kind !== channelId ? triggers[`${kind}.webhook`] : undefined)
}

interface AgentTriggerResolutionOptions {
  /** Collects the `channelState.transaction()` writes of the invoked Channel trigger, for its caller to commit. */
  channelStateCommit?: AgentChannelStateCommit
  queuedInvocation?: AgentChannelTriggerContext["queuedInvocation"]
  /** Raw body of the webhook request that runs the trigger. An unset `webhook.deliveryId` defaults to its SHA-256. */
  rawBody?: string | Uint8Array
  /** Persisted queue delivery ID, used when replayed bytes were stored as text. */
  deliveryId?: string
  /** When the webhook request first arrived, for timestamped signatures. See `AgentWebhookVerificationOptions.receivedAt`. */
  receivedAt?: number
}

/** Binds `prepare` and each task of a trigger to the context that its `invoke` receives. */
async function bindAgentTriggerCallbacks<TContext>(
  id: string,
  trigger: Pick<AgentTriggerDefinition<AgentRuntimeConfig, WorkspaceName, unknown, unknown, never>, "prepare" | "tasks">,
  context: TContext,
): Promise<Pick<ResolvedAgentTriggerDefinition, "prepare" | "tasks">> {
  // SAFETY: The trigger definition declares its callbacks for this trigger's context type.
  const prepare = trigger.prepare as ((context: TContext, invocation: AgentTriggerAcceptedInvocation) => MaybePromise<AgentTriggerPrepareResult>) | undefined
  const bound: Pick<ResolvedAgentTriggerDefinition, "prepare" | "tasks"> = {}
  if (prepare !== undefined) {
    if (typeof prepare !== "function") throw agentDiagnostics.AGENT_TRIGGER_PREPARE_INVALID({ triggerId: id })
    bound.prepare = invocation => prepare(context, invocation)
  }
  if (trigger.tasks === undefined) return bound
  if (!isRuntimeRecord(trigger.tasks)) throw agentDiagnostics.AGENT_TRIGGER_TASKS_INVALID({ triggerId: id })
  const tasks: Record<string, ResolvedAgentTriggerTask> = {}
  for (const [name, task] of Object.entries(trigger.tasks)) {
    if (!isRuntimeRecord(task)) throw agentDiagnostics.AGENT_TRIGGER_TASK_INVALID({ task: name, triggerId: id, problem: "must be an object." })
    if ((task.agent === undefined) === (task.run === undefined)) {
      throw agentDiagnostics.AGENT_TRIGGER_TASK_INVALID({ task: name, triggerId: id, problem: "must declare exactly one of agent or run." })
    }
    const target: unknown = typeof task.agent === "function" && !hasAgentDefinition(task.agent) ? await task.agent() : task.agent
    const agent: unknown = !hasAgentDefinition(target) && isRuntimeRecord(target) && "default" in target ? target.default : target
    const agentName: unknown = isRuntimeRecord(agent) ? agent.name : undefined
    if (task.agent !== undefined && !(hasAgentDefinition(agent) && typeof agentName === "string" && agentName.trim())) {
      throw agentDiagnostics.AGENT_TASK_AGENT_NAME_MISSING({ task: name, triggerId: id })
    }
    if (task.run !== undefined && typeof task.run !== "function") throw agentDiagnostics.AGENT_TRIGGER_TASK_INVALID({ task: name, triggerId: id, problem: "run must be a function." })
    if (task.prepare !== undefined && typeof task.prepare !== "function") throw agentDiagnostics.AGENT_TRIGGER_TASK_INVALID({ task: name, triggerId: id, problem: "prepare must be a function." })
    if (task.failed !== undefined && typeof task.failed !== "function") throw agentDiagnostics.AGENT_TRIGGER_TASK_INVALID({ task: name, triggerId: id, problem: "failed must be a function." })
    // SAFETY: The checks above validated the task shape that the trigger definition declares for its context type.
    const { failed, prepare: taskPrepare, run } = task as {
      failed?: ResolvedAgentTriggerTask["failed"]
      prepare?: (context: TContext, invocation: AgentTriggerAcceptedInvocation) => MaybePromise<AgentTriggerPrepareResult>
      run?: (context: TContext, invocation: AgentTriggerAcceptedInvocation) => MaybePromise<unknown>
    }
    tasks[name] = {
      // SAFETY: The Agent and its stable name were validated above after resolving a lazy task target.
      ...(agent ? { agent: agent as AgentInput } : {}),
      ...(failed ? { failed } : {}),
      ...(taskPrepare ? { prepare: (invocation: AgentTriggerAcceptedInvocation) => taskPrepare(context, invocation) } : {}),
      ...(run ? { run: (invocation: AgentTriggerAcceptedInvocation) => run(context, invocation) } : {}),
    }
  }
  bound.tasks = tasks
  return bound
}

export async function resolveAgentTriggers<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  options: AgentTriggerResolutionOptions = {},
): Promise<Record<string, ResolvedAgentTriggerDefinition<TRuntimeConfig>>> {
  const { channelStateCommit, queuedInvocation } = options
  const runtimeContext = createAgentCallbackContext(context)
  const capabilities = normalizeCapabilities(agentCapabilityOptions(agent) as never) as AgentCapabilityDefinition<TRuntimeConfig>[]
  const triggers: Record<string, ResolvedAgentTriggerDefinition<TRuntimeConfig>> = {}
  for (const capability of capabilities) {
    for (const [name, trigger] of Object.entries(capability.triggers || {})) {
      const id = `${capability.id}.${name}` as const
      const triggerContext = {
        ...runtimeContext,
        capability,
        trigger: {
          capabilityId: capability.id,
          id,
          name,
          source: "capability" as const,
        },
      }
      triggers[id] = {
        capabilityId: capability.id,
        definition: trigger as never,
        id,
        input: trigger.input,
        invoke: input => trigger.invoke(triggerContext, input as never),
        ...await bindAgentTriggerCallbacks(id, trigger as never, triggerContext),
        name,
        output: trigger.output,
        source: "capability",
        webhooks: trigger.webhooks,
      }
    }
  }
  for (const [channelId, channel] of Object.entries(agentChannelOptions(agent))) {
    const channelCapabilities = normalizeCapabilities([...capabilities, ...(channel.capabilities || [])]) as AgentCapabilityDefinition<TRuntimeConfig>[]
    const channelWebhooks = normalizeChannelWebhookRegistrations(channelId, channel.kind, channel.webhooks)
    const channelState = agentChannelTriggerState(context.request, channelId)
    const capabilityWebhookTrigger = capabilityWebhookTriggerForChannel(triggers, channelId, channel.kind)
    if (capabilityWebhookTrigger && channelWebhooks?.length) {
      capabilityWebhookTrigger.webhooks = [
        ...(capabilityWebhookTrigger.webhooks || []),
        ...channelWebhooks,
      ]
    }
    for (const [name, trigger] of Object.entries(channel.triggers || {})) {
      assertTriggerName(name, `Channel "${channelId}"`)
      const id = `${channelId}.${name}` as const
      if (triggers[id]) {
        throw agentDiagnostics.AGENT_R0870({ message: `[vitehub] Duplicate Agent trigger "${id}" from Channel "${channelId}".` })
      }
      const dispatch = (items: readonly AgentChannelDispatchItem[], options: AgentChannelDispatchOptions) => options?.queue
        ? queueAgentChannelItems(context, channelId, items, options)
        : dispatchAgentChannelItems(agent, context, channelId, items, options)
      // Transactions stage into the caller's commit, which writes them with the queue admission of the result.
      const triggerState = channelState && createAgentChannelState(channelState, channelStateCommit)
      const triggerContext = {
        ...runtimeContext,
        agentCapabilities: channelCapabilities,
        agentName: agent.name || runtimeContext.agentIdentity?.name,
        channel,
        ...(queuedInvocation ? { queuedInvocation } : {}),
        ...(triggerState ? { channelState: triggerState } : {}),
        dispatch,
        pull: <TCursor extends string | number>(pullOptions: AgentChannelPullOptions<TCursor>) =>
          pullAgentChannel({ channelState: triggerState, dispatch, trigger: { id } }, pullOptions),
        trigger: { channelId, id, name, source: "channel" as const },
      }
      triggers[id] = {
        channelId,
        definition: trigger as never,
        id,
        input: trigger.input,
        invoke: (input) => {
          if (trigger.durableState === true && !channelState) throw agentDiagnostics.AGENT_R1005({ trigger: id })
          return trigger.invoke(triggerContext as never, input as never)
        },
        ...await bindAgentTriggerCallbacks(id, trigger as never, triggerContext),
        name,
        output: trigger.output,
        source: "channel",
        webhooks: trigger.webhooks || channelWebhooks,
      }
    }
  }
  return triggers
}

export interface ResolvedAgentTriggerInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  /** The Agent of the selected task. Unset when the Agent that owns the trigger runs the input. */
  agent?: AgentInput
  input: AgentRunInput<CALL_OPTIONS>
  metadata?: Record<string, unknown>
  run?: AgentRunMetadata
  /** The key of the selected task. */
  task?: string
  trigger: ResolvedAgentTriggerDefinition<TRuntimeConfig, unknown, CALL_OPTIONS>
  webhook?: AgentWebhookInvocationOwnership<CALL_OPTIONS>
}

export interface ResolvedAgentTriggerHandledInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> {
  response: Response
  trigger: ResolvedAgentTriggerDefinition<TRuntimeConfig, unknown, CALL_OPTIONS>
}

export type ResolvedAgentTriggerInvocationResult<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> =
  | ResolvedAgentTriggerInvocation<TRuntimeConfig, CALL_OPTIONS>
  | ResolvedAgentTriggerHandledInvocation<TRuntimeConfig, CALL_OPTIONS>

export function isResolvedAgentTriggerHandledInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  invocation: ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS>,
): invocation is ResolvedAgentTriggerHandledInvocation<TRuntimeConfig, CALL_OPTIONS> {
  return "response" in invocation && isResponse(invocation.response)
}

export interface AgentWebhookVerificationResult {
  registration?: AgentWebhookRegistrationDefinition
  verified: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function resolveWebhookSecret(
  value: unknown,
  context: AgentCallbackContext,
): Promise<unknown> {
  if (value === undefined) return undefined
  // A string names the server variable that holds the secret, as in Webhooks.
  if (typeof value === "string") return serverVariable(value)
  if (typeof value === "function") {
    return unsealWebhookSecret(await value(context))
  }
  if (isRecord(value) && Object.hasOwn(value, "resolve") && typeof value.resolve === "function") {
    return unsealWebhookSecret(await value.resolve(context))
  }
  return unsealWebhookSecret(value)
}

/** A sealed Server Env secret (`{ unseal() }`) resolves to its value. */
function unsealWebhookSecret(value: unknown): unknown {
  return isRecord(value) && typeof value.unseal === "function" ? value.unseal() : value
}

/** `signature: "bearer"` reads `Authorization` unless `secretHeader` names another header. */
export function webhookSecretHeader(registration: AgentWebhookRegistrationDefinition): string | undefined {
  return registration.secretHeader ?? (registration.signature === "bearer" ? "authorization" : undefined)
}

/** `Bearer <secret>`, with the scheme compared case-insensitively and the token in constant time. */
async function verifyBearerSignature(secret: string, header: string): Promise<boolean> {
  const match = /^bearer[ \t]+(.+)$/i.exec(header.trim())
  // Without the scheme, still run the comparison so a malformed header takes the same time.
  return await constantTimeEqual(secret, match?.[1] ?? `\0${header}`)
}

function missingBearerSecretError(registration: AgentWebhookRegistrationDefinition): AgentHttpError {
  return agentHttpError(500, `[vitehub] Channel "${registration.channelId || registration.id || registration.provider}" uses signature "bearer", but its secret resolved to no secret. Set the server variable that secret names, or return false from a secret function to disable verification.`)
}

async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
}

type HmacSignaturePreset = Extract<NonNullable<AgentWebhookRegistrationDefinition["signature"]>, { type: "hmac-sha256" }>

function hmacSignaturePreset(signature: AgentWebhookRegistrationDefinition["signature"]): HmacSignaturePreset | undefined {
  if (signature === "github") return { type: "hmac-sha256", ...githubHmacSignatureFormat }
  if (isRecord(signature) && "type" in signature && signature.type === "hmac-sha256") return signature
  return undefined
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)])
  let diff = leftDigest.length ^ rightDigest.length
  for (let index = 0; index < Math.max(leftDigest.length, rightDigest.length); index += 1) {
    diff |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0)
  }
  return diff === 0
}

function stripeSignatureTolerance(signature: AgentWebhookRegistrationDefinition["signature"]): number | undefined {
  if (signature === "stripe") return stripeSignatureToleranceSeconds
  if (isRecord(signature) && "type" in signature && signature.type === "stripe") {
    return signature.tolerance === undefined ? stripeSignatureToleranceSeconds : parseDuration(signature.tolerance, "tolerance") / 1000
  }
  return undefined
}

function webhookVerificationError(message: string): AgentHttpError {
  return agentHttpError(401, message)
}

function unresolvedSecretError(registration: AgentWebhookRegistrationDefinition): AgentHttpError {
  return webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secret but it resolved to no secret. Set the server variable that secret names; secret: false explicitly disables verification.`)
}

export interface AgentWebhookVerificationOptions {
  rawBody?: Uint8Array
  /**
   * When the request first arrived, in milliseconds. Timestamped signatures are checked
   * against it, so a replay of a stored request is not rejected as expired. Defaults to now.
   */
  receivedAt?: number
  requireSecretHeader?: boolean
}

async function verifyRequiredWebhookHeaders<TRuntimeConfig extends AgentRuntimeConfig>(
  registrations: AgentWebhookRegistrationDefinition<TRuntimeConfig>[],
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<AgentWebhookVerificationResult> {
  let unconfigured: AgentWebhookRegistrationDefinition<TRuntimeConfig> | undefined
  for (const registration of registrations) {
    const resolvedSecret = await resolveWebhookSecret(registration.secret, context)
    if (resolvedSecret !== undefined && resolvedSecret !== false && typeof resolvedSecret !== "string") {
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" resolved secret to an invalid value.`)
    }
    if (!resolvedSecret && resolvedSecret !== false && registration.signature === "bearer") throw missingBearerSecretError(registration)
    const secretHeader = webhookSecretHeader(registration)
    if (!secretHeader) {
      if (resolvedSecret === false) return { registration, verified: true }
      if (resolvedSecret) {
        throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secret but no secretHeader is configured. Verification requires secretHeader; secret: false explicitly disables verification.`)
      }
      if (registration.secret !== undefined) {
        throw unresolvedSecretError(registration)
      }
      if (registration.signature === undefined) unconfigured ??= registration
      continue
    }
    if (resolvedSecret === false) {
      return { registration, verified: true }
    }
    if (!resolvedSecret) {
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secretHeader "${secretHeader}" but no secret is configured. Set secret to the name of the server variable that holds it; secret: false explicitly disables verification.`)
    }
    throw webhookVerificationError(`[vitehub] Webhook secret header "${secretHeader}" is required.`)
  }
  // No registration verified the request. A required check never passes by default.
  if (unconfigured) {
    throw webhookVerificationError(`[vitehub] Webhook registration "${unconfigured.id || unconfigured.provider}" declares no verification. Set secret with secretHeader, signature: "bearer", or signature: { verify }; secret: false explicitly disables verification.`)
  }
  throw webhookVerificationError("[vitehub] Webhook secret verification failed.")
}

export async function verifyAgentWebhookRequest<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  registrations: AgentWebhookRegistrationDefinition<TRuntimeConfig>[],
  request: Request,
  context?: AgentCallbackContext<TRuntimeConfig>,
  options: AgentWebhookVerificationOptions = {},
): Promise<AgentWebhookVerificationResult> {
  const values = new Map<string, unknown>()
  const verificationContext = context ?? {
    capabilities: {},
    memo<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create())
      return values.get(key) as T
    },
    runtime: "unknown",
    waitUntil: task => void Promise.resolve(task).catch(() => {}),
  }
  const targeted = registrations
    .map((registration) => {
      const secretHeader = webhookSecretHeader(registration)
      return { headerValue: secretHeader ? request.headers.get(secretHeader) : null, registration }
    })
    .filter((entry): entry is { headerValue: string | null, registration: AgentWebhookRegistrationDefinition } =>
      entry.headerValue !== null || (typeof entry.registration.signature === "object" && entry.registration.signature !== null && "verify" in entry.registration.signature && typeof entry.registration.signature.verify === "function"))

  if (!targeted.length) {
    return options.requireSecretHeader
      ? await verifyRequiredWebhookHeaders(registrations, verificationContext)
      : { verified: true }
  }

  // A request body can be needed by several targeted signature verifiers. Read it
  // once, then give each verifier its own copy so one verifier cannot affect the
  // bytes seen by the next verifier.
  let requestBody: Promise<Uint8Array> | undefined
  const readRawBody = async (): Promise<Uint8Array<ArrayBuffer>> => {
    if (options.rawBody) return Uint8Array.from(options.rawBody)
    requestBody ??= request.clone().arrayBuffer().then(value => new Uint8Array(value))
    return Uint8Array.from(await requestBody)
  }

  for (const { headerValue, registration } of targeted) {
    const resolvedSecret = await resolveWebhookSecret(registration.secret, verificationContext)
    if (resolvedSecret !== undefined && resolvedSecret !== false && typeof resolvedSecret !== "string") {
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" resolved secret to an invalid value.`)
    }
    if (resolvedSecret === false) {
      return { registration, verified: true }
    }
    if (typeof registration.signature === "object" && registration.signature !== null && "verify" in registration.signature && typeof registration.signature.verify === "function") {
      // A declared secret that resolves to nothing must not reach `verify` as an empty key.
      if (!resolvedSecret && registration.secret !== undefined) {
        throw unresolvedSecretError(registration)
      }
      const rawBody = await readRawBody()
      if (await registration.signature.verify({ context: verificationContext, header: headerValue ?? "", rawBody, request, secret: resolvedSecret || "" })) {
        return { registration, verified: true }
      }
      continue
    }
    if (!resolvedSecret) {
      if (registration.signature === "bearer") throw missingBearerSecretError(registration)
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secretHeader "${registration.secretHeader}" but no secret is configured. Set secret to the name of the server variable that holds it; secret: false explicitly disables verification.`)
    }
    if (headerValue === null) continue
    if (registration.signature === "bearer") {
      if (await verifyBearerSignature(resolvedSecret, headerValue)) {
        return { registration, verified: true }
      }
      continue
    }
    const stripeTolerance = stripeSignatureTolerance(registration.signature)
    if (stripeTolerance !== undefined) {
      const rawBody = await readRawBody()
      if (await verifyViteHubStripeSignature(resolvedSecret, headerValue, rawBody, { receivedAt: options.receivedAt, toleranceSeconds: stripeTolerance })) {
        return { registration, verified: true }
      }
      continue
    }
    const hmacSignature = hmacSignaturePreset(registration.signature)
    if (hmacSignature) {
      if (await verifyViteHubHmacSignature(resolvedSecret, headerValue, await readRawBody(), hmacSignature)) {
        return { registration, verified: true }
      }
      continue
    }
    if (await constantTimeEqual(resolvedSecret, headerValue)) {
      return { registration, verified: true }
    }
  }

  throw webhookVerificationError("[vitehub] Webhook secret verification failed.")
}

function requiresWebhookSecretHeader(registrations: AgentWebhookRegistrationDefinition[]) {
  return registrations.some(registration => registration.signature === "bearer" || (registration.secret !== undefined && registration.secret !== false))
}

function withAgentTriggerContext<CALL_OPTIONS>(
  input: AgentRunInput<CALL_OPTIONS>,
  trigger: Pick<ResolvedAgentTriggerDefinition, "capabilityId" | "channelId" | "id" | "name" | "source">,
  delivery?: AgentTriggerRunInvokeResult<CALL_OPTIONS>["delivery"],
  message?: unknown,
): AgentRunInput<CALL_OPTIONS> {
  const context = { ...input.context }
  if (message !== undefined) context[channelMessageContextKey] = message
  const effects = delivery?.effects ? Array.isArray(delivery.effects) ? delivery.effects : [delivery.effects] : undefined
  const finishEffects = delivery?.finishEffects ? Array.isArray(delivery.finishEffects) ? delivery.finishEffects : [delivery.finishEffects] : undefined
  if (effects?.length) context[channelDeliveryEffectsContextKey] = effects as AgentChannelDeliveryEffectIntent[]
  if (finishEffects?.length) context[channelDeliveryFinishEffectsContextKey] = finishEffects as AgentChannelDeliveryFinishEffect[]
  return {
    ...input,
    context: {
      ...context,
      [agentTriggerContextKey]: {
        ...(trigger.capabilityId ? { capabilityId: trigger.capabilityId } : {}),
        ...(trigger.channelId ? { channelId: trigger.channelId } : {}),
        id: trigger.id,
        name: trigger.name,
        source: trigger.source,
      },
    },
  }
}

export type RunAgentTriggerExecutor<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
) => Promise<Response | AgentRunResult | unknown>

export type StreamAgentTriggerExecutor<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
  options?: { output?: "events" | "ui-message-stream" },
) => Promise<Response | AsyncIterable<StreamEvent> | unknown>

export async function resolveAgentTriggerInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  triggerId: string,
  input: TInput,
  options?: AgentTriggerResolutionOptions & { verifyWebhook?: boolean },
): Promise<ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS>> {
  const triggers = await resolveAgentTriggers(agent, context, options)
  let trigger = triggers[triggerId] as ResolvedAgentTriggerDefinition<TRuntimeConfig, TInput, CALL_OPTIONS> | undefined
  if (!trigger) {
    throw agentDiagnostics.AGENT_R0871({ message: `[vitehub] Agent trigger "${triggerId}" is not defined by this agent.` })
  }
  if (options?.verifyWebhook !== false && trigger.webhooks?.length && context.request) {
    await verifyAgentWebhookRequest(trigger.webhooks, context.request, createAgentCallbackContext(context), {
      ...(options?.receivedAt === undefined ? {} : { receivedAt: options.receivedAt }),
      requireSecretHeader: requiresWebhookSecretHeader(trigger.webhooks),
    })
  }
  const eventTarget = channelWebhookEventTarget(trigger.definition)
  if (eventTarget && options?.rawBody !== undefined) {
    const request = context.request
    const name = eventTarget.webhook.event?.(isRecord(input) ? input.payload : undefined, {
      headers: request ? Object.fromEntries(request.headers.entries()) : {},
      method: request?.method ?? "POST",
      url: request?.url ?? "",
    }) ?? "webhook"
    const channelId = trigger.channelId
    const selected = Object.values(triggers).find(candidate => candidate.channelId === channelId
      && channelWebhookEventTarget(candidate.definition)?.webhook === eventTarget.webhook
      && channelWebhookEventTarget(candidate.definition)?.name === name)
    if (!selected) return { response: Response.json({ accepted: false, ok: true, reason: `no target for event "${name}"` }), trigger: trigger as never }
    // SAFETY: The selected trigger validates its input below, before invoke runs.
    trigger = selected as ResolvedAgentTriggerDefinition<TRuntimeConfig, TInput, CALL_OPTIONS>
  }
  let validatedInput = input
  if (isTriggerInputSchema(trigger.input)) {
    if (trigger.webhooks?.length && context.request) {
      const result = await trigger.input["~standard"].validate(input)
      if (result.issues?.length || !("value" in result)) {
        return {
          response: Response.json({ accepted: false, reason: "invalid_payload" }, { status: 400 }),
          // SAFETY: A handled invalid payload never invokes the trigger, so its validated input type remains opaque to consumers.
          trigger: trigger as never,
        }
      }
      validatedInput = result.value
    } else {
      validatedInput = await parseStandardSchema(trigger.input, input, `Agent trigger "${trigger.id}" input`)
    }
  }
  const result = await trigger.invoke(validatedInput)
  if (isResponse(result)) return resolveAgentTriggerInvocationResult(result, trigger)
  const invokedRun = result.run ? { ...context.run, ...result.run } : context.run
  const webhook = options?.deliveryId && result.webhook && result.webhook.deliveryId === undefined
    ? { ...result.webhook, deliveryId: options.deliveryId }
    : await withBodyDeliveryId(result.webhook, options?.rawBody)
  const invoked = withWebhookDeliveryRun({
    ...result,
    ...(invokedRun ? { run: invokedRun } : {}),
    ...(webhook ? { webhook } : {}),
  }, trigger)
  const annotations = channelHistoryAnnotations(agent, trigger, validatedInput)
  const inheritedRun = invoked.run && { ...invoked.run }
  const run = annotations
    ? { ...(inheritedRun ?? { runId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}` }), annotations: { ...inheritedRun?.annotations, ...annotations } }
    : inheritedRun
  return resolveAgentTriggerInvocationResult(withTaskOrigin({
    ...invoked,
    ...(run ? { run } : {}),
  }, trigger), trigger)
}

/**
 * A webhook delivery without `deliveryId` is identified by the SHA-256 (hex) of its raw body, so an identical retried
 * body is the same delivery. The queue stores the body as text, so a replay hashes the same value.
 */
async function withBodyDeliveryId<CALL_OPTIONS>(
  webhook: AgentWebhookInvocationOwnership<CALL_OPTIONS> | undefined,
  rawBody: string | Uint8Array | undefined,
): Promise<AgentWebhookInvocationOwnership<CALL_OPTIONS> | undefined> {
  if (!webhook || webhook.deliveryId !== undefined || rawBody === undefined) return webhook
  return { ...webhook, deliveryId: hexBytes(await sha256(rawBody)) }
}

/** Applies the body `deliveryId` default to the result of `webhook.rehydrate()` during a queued replay. */
export async function withRehydratedBodyDeliveryId<CALL_OPTIONS>(
  result: AgentTriggerInvokeResult<CALL_OPTIONS>,
  rawBody: string | Uint8Array,
  fallbackDeliveryId?: string,
): Promise<AgentTriggerInvokeResult<CALL_OPTIONS>> {
  if (isResponse(result) || !result.webhook) return result
  const webhook = result.webhook.deliveryId === undefined && fallbackDeliveryId
    ? { ...result.webhook, deliveryId: fallbackDeliveryId }
    : await withBodyDeliveryId(result.webhook, typeof rawBody === "string" ? new TextEncoder().encode(rawBody) : rawBody)
  return { ...result, webhook }
}

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * A Channel trigger result with `webhook.deliveryId` runs under that ID. Unset `run.runId` and
 * `run.channelId` default to the delivery ID and the Channel, so a retried delivery keeps one Invocation.
 */
function withWebhookDeliveryRun<CALL_OPTIONS>(
  invoked: AgentTriggerRunInvokeResult<CALL_OPTIONS>,
  trigger: Pick<ResolvedAgentTriggerDefinition, "channelId">,
): AgentTriggerRunInvokeResult<CALL_OPTIONS> {
  const deliveryId = invoked.webhook?.deliveryId
  if (!trigger.channelId || typeof deliveryId !== "string" || !deliveryId.trim()) return invoked
  return { ...invoked, run: { channelId: trigger.channelId, ...invoked.run, runId: invoked.run?.runId || deliveryId } }
}

/** The Invocation of an Agent task defaults its unset `run.origin` to the task key, so the Console shows which task ran. */
function withTaskOrigin<CALL_OPTIONS>(
  invoked: AgentTriggerRunInvokeResult<CALL_OPTIONS>,
  trigger: { id: string, tasks?: Record<string, ResolvedAgentTriggerTask<CALL_OPTIONS>> },
): AgentTriggerRunInvokeResult<CALL_OPTIONS> {
  if (invoked.task === undefined || !invoked.run || invoked.run.origin !== undefined) return invoked
  if (!agentTriggerTask(trigger, invoked.task).agent) return invoked
  return { ...invoked, run: { ...invoked.run, origin: invoked.task } }
}

export function resolveAgentTriggerInvocationResult<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  invocation: AgentTriggerInvokeResult<CALL_OPTIONS>,
  trigger: ResolvedAgentTriggerDefinition<TRuntimeConfig, TInput, CALL_OPTIONS>,
): ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS> {
  if (isResponse(invocation)) {
    return {
      response: invocation,
      trigger: trigger as never,
    }
  }
  const normalized = withWebhookDeliveryRun(invocation, trigger)
  const task = normalized.task === undefined ? undefined : agentTriggerTask(trigger, normalized.task)
  return {
    ...(task?.agent ? { agent: task.agent } : {}),
    input: withAgentTriggerContext(normalized.input, trigger, normalized.delivery, normalized.message),
    metadata: normalized.metadata,
    run: normalized.run,
    ...(normalized.task !== undefined ? { task: normalized.task } : {}),
    trigger: trigger as never,
    webhook: withSerializedWebhook(normalized.webhook, trigger),
  }
}

/** The declared task `name` of a trigger. Throws when the trigger does not declare it. */
export function agentTriggerTask<CALL_OPTIONS = unknown>(
  trigger: { id: string, tasks?: Record<string, ResolvedAgentTriggerTask<CALL_OPTIONS>> },
  name: unknown,
): ResolvedAgentTriggerTask<CALL_OPTIONS> {
  const task = typeof name === "string" && trigger.tasks && Object.hasOwn(trigger.tasks, name) ? trigger.tasks[name] : undefined
  if (!task) throw agentDiagnostics.AGENT_TRIGGER_TASK_UNKNOWN({ task: String(name), triggerId: trigger.id })
  return task
}

/**
 * Runs the preparation of an accepted invocation: the task's `prepare`, or the trigger's `prepare` without a task,
 * then a task's `run`. Returns the invocation to start, or the handled `Response` that settles it.
 * `agentName` is the Agent that owns the trigger. A task Agent owns the Invocation of its task.
 */
export async function prepareAgentTriggerInvocation<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  invocation: ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS>,
  agentName: string | undefined,
): Promise<ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS>> {
  if (isResolvedAgentTriggerHandledInvocation(invocation)) return invocation
  const task = invocation.task === undefined ? undefined : agentTriggerTask(invocation.trigger, invocation.task)
  // A task owns its preparation. Only an invocation without a task runs the trigger's `prepare`.
  const prepare = task ? task.prepare : invocation.trigger.prepare
  if (!prepare && !task?.run) return invocation
  const reference = await runInvocationReference(task?.agent ? taskAgentIdentity(task.agent).name : agentName, invocation.run)
  const accepted = (input: AgentRunInput<CALL_OPTIONS>): AgentTriggerAcceptedInvocation<CALL_OPTIONS> => ({
    input,
    ...(reference ? { invocation: reference } : {}),
    ...(invocation.run ? { run: invocation.run } : {}),
  })
  let prepared = invocation
  if (prepare) {
    const result = await prepare(accepted(invocation.input))
    if (isResponse(result)) return { response: result, trigger: invocation.trigger }
    if (result) prepared = { ...invocation, input: result }
  }
  if (!task?.run) return prepared
  const output = await task.run(accepted(prepared.input))
  return { response: isResponse(output) ? output : new Response(null, { status: 204 }), trigger: invocation.trigger }
}

/** The host identity of a task Agent. Its Invocations belong to that Agent, not to the Agent that owns the trigger. */
export function taskAgentIdentity(agent: AgentInput): { name: string } {
  if (typeof agent.name !== "string" || !agent.name.trim()) throw agentDiagnostics.AGENT_TASK_AGENT_NAME_MISSING({})
  return { name: agent.name }
}

function withTaskAgentIdentity<TContext extends object>(context: TContext, agent: AgentInput | undefined): TContext {
  return agent ? { ...context, agentIdentity: taskAgentIdentity(agent) } : context
}

/** `webhook.serialize: key` is `{ concurrencyKey: key, concurrencyLimit: 1 }`. */
function withSerializedWebhook<CALL_OPTIONS>(
  webhook: AgentWebhookInvocationOwnership<CALL_OPTIONS> | undefined,
  trigger: Pick<ResolvedAgentTriggerDefinition, "id">,
): AgentWebhookInvocationOwnership<CALL_OPTIONS> | undefined {
  if (webhook?.serialize === undefined) return webhook
  const { serialize, ...ownership } = webhook
  if (typeof serialize !== "string" || !serialize.trim()) {
    throw agentDiagnostics.AGENT_TRIGGER_SERIALIZE_INVALID({ triggerId: trigger.id })
  }
  if (ownership.concurrencyKey !== undefined || ownership.concurrencyLimit !== undefined) {
    throw agentDiagnostics.AGENT_TRIGGER_SERIALIZE_CONFLICT({ triggerId: trigger.id })
  }
  return { ...ownership, concurrencyKey: serialize, concurrencyLimit: 1 }
}

export async function runAgentTriggerWith<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  executor: RunAgentTriggerExecutor<TRuntimeConfig, CALL_OPTIONS>,
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  triggerId: string,
  input: TInput,
): Promise<Response | AgentRunResult | unknown> {
  const invocation = await prepareAgentTriggerInvocation(await resolveAgentTriggerInvocation<TRuntimeConfig, TInput, CALL_OPTIONS>(agent, context, triggerId, input), agentInvocationName(agent, context))
  if (isResolvedAgentTriggerHandledInvocation(invocation)) return invocation.response
  // SAFETY: A task Agent runs with the same runtime configuration as the Agent that owns the trigger.
  const executionAgent = (invocation.agent ?? agent) as AgentInput<AgentRuntimeContext<TRuntimeConfig>>
  return await executor(executionAgent, withTaskAgentIdentity({ ...context, ...(invocation.run ? { run: invocation.run } : {}) }, invocation.agent), invocation.input)
}

export async function streamAgentTriggerWith<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  executor: StreamAgentTriggerExecutor<TRuntimeConfig, CALL_OPTIONS>,
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
  triggerId: string,
  input: TInput,
  options: {
    onInvocation?: (invocation: ResolvedAgentTriggerInvocation<TRuntimeConfig, CALL_OPTIONS>) => MaybePromise<void>
    output?: "events" | "ui-message-stream"
  } = {},
): Promise<Response | AsyncIterable<StreamEvent> | unknown> {
  const invocation = await prepareAgentTriggerInvocation(await resolveAgentTriggerInvocation<TRuntimeConfig, TInput, CALL_OPTIONS>(agent, context, triggerId, input), agentInvocationName(agent, context))
  if (isResolvedAgentTriggerHandledInvocation(invocation)) return invocation.response
  await options.onInvocation?.(invocation)
  const output = options.output || (invocation.trigger.output === "ui-message-stream" ? "ui-message-stream" : "events")
  // SAFETY: A task Agent runs with the same runtime configuration as the Agent that owns the trigger.
  const executionAgent = (invocation.agent ?? agent) as AgentInput<AgentRuntimeContext<TRuntimeConfig>>
  return await executor(executionAgent, withTaskAgentIdentity({ ...context, ...(invocation.run ? { run: invocation.run } : {}) }, invocation.agent), invocation.input, { output })
}
