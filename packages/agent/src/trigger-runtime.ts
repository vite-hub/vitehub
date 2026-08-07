import {
  channelDeliveryEffectsContextKey,
  channelDeliveryFinishEffectsContextKey,
  normalizeCapabilities,
} from "./capability-runtime.ts"
import { AgentHttpError } from "./http-error.ts"

import type {
  AgentCallbackContext,
  AgentCapabilityDefinition,
  AgentChannelDefinition,
  AgentChannelDeliveryEffectIntent,
  AgentChannelDeliveryFinishEffect,
  AgentChannels,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentTriggerInvokeResult,
  AgentTriggerRunInvokeResult,
  AgentWebhookInvocationOwnership,
  AgentWebhookRegistrationDefinition,
  MaybePromise,
  MaybeResolvable,
  ResolvedAgentRuntimeContext,
  ResolvedAgentTriggerDefinition,
} from "./types.ts"
import type { StreamEvent } from "./messages.ts"
import type { WorkspaceName } from "@vite-hub/workspace"

const agentTriggerContextKey = "agent.trigger"

type WorkspaceAgentOptions<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = {
  capabilities?: AgentCapabilityDefinition<TRuntimeConfig, Name>[]
  channels?: AgentChannels<TRuntimeConfig>
}

type WorkspaceAgentDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  Name extends WorkspaceName = WorkspaceName,
> = {
  __vitehubWorkspaceAgentOptions?: WorkspaceAgentOptions<TRuntimeConfig, Name>
}

function hasAgentDefinition(value: unknown): value is { capabilities?: AgentCapabilityDefinition[], resolve: (...args: unknown[]) => unknown } {
  return typeof value === "object"
    && value !== null
    && "resolve" in value
    && typeof (value as { resolve?: unknown }).resolve === "function"
}

function createAgentCallbackContext<TRuntimeConfig extends AgentRuntimeConfig>(
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
) {
  const { runtimeConfig: _runtimeConfig, ...callbackContext } = context
  return callbackContext
}

function agentCapabilityOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentCapabilityDefinition<TRuntimeConfig>[] {
  if (!hasAgentDefinition(agent)) return []
  const workspaceDefinition = agent as Partial<WorkspaceAgentDefinition<TRuntimeConfig>>
  const workspaceOptions = workspaceDefinition.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig> | undefined
  const capabilities = agent.capabilities || workspaceOptions?.capabilities
  return (Array.isArray(capabilities) ? capabilities : []) as AgentCapabilityDefinition<TRuntimeConfig>[]
}

function agentChannelOptions<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
): AgentChannels<TRuntimeConfig> {
  if (!hasAgentDefinition(agent)) return {}
  const workspaceDefinition = agent as Partial<WorkspaceAgentDefinition<TRuntimeConfig>>
  const workspaceOptions = workspaceDefinition.__vitehubWorkspaceAgentOptions as WorkspaceAgentOptions<TRuntimeConfig> | undefined
  return (agent.channels || workspaceOptions?.channels || {}) as AgentChannels<TRuntimeConfig>
}

function assertTriggerName(name: unknown, owner: string): asserts name is string {
  if (typeof name !== "string" || !name.trim()) {
    throw new TypeError(`[vitehub] ${owner} trigger names must be non-empty strings.`)
  }
  if (!/^[a-z][a-z0-9-_]*$/i.test(name)) {
    throw new TypeError(`[vitehub] ${owner} trigger "${name}" must be a stable local identifier.`)
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

export async function resolveAgentTriggers<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: ResolvedAgentRuntimeContext<TRuntimeConfig>,
): Promise<Record<string, ResolvedAgentTriggerDefinition<TRuntimeConfig>>> {
  const runtimeContext = createAgentCallbackContext(context)
  const capabilities = normalizeCapabilities(agentCapabilityOptions(agent) as never) as AgentCapabilityDefinition<TRuntimeConfig>[]
  const triggers: Record<string, ResolvedAgentTriggerDefinition<TRuntimeConfig>> = {}
  for (const capability of capabilities) {
    for (const [name, trigger] of Object.entries(capability.triggers || {})) {
      const id = `${capability.id}.${name}` as const
      triggers[id] = {
        capabilityId: capability.id,
        definition: trigger as never,
        id,
        input: trigger.input,
        invoke: input => trigger.invoke({
          ...runtimeContext,
          capability,
          trigger: {
            capabilityId: capability.id,
            id,
            name,
            source: "capability",
          },
        }, input as never),
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
        throw new Error(`[vitehub] Duplicate Agent trigger "${id}" from Channel "${channelId}".`)
      }
      triggers[id] = {
        channelId,
        definition: trigger as never,
        id,
        input: trigger.input,
        invoke: input => trigger.invoke({
          ...runtimeContext,
          agentCapabilities: channelCapabilities,
          channel,
          trigger: {
            channelId,
            id,
            name,
            source: "channel",
          },
        } as never, input as never),
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
  input: AgentRunInput<CALL_OPTIONS>
  metadata?: Record<string, unknown>
  run?: AgentRunMetadata
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
  return "response" in invocation && invocation.response instanceof Response
}

export interface AgentWebhookVerificationResult {
  registration?: AgentWebhookRegistrationDefinition
  verified: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isResolvableObject<T, TContext extends AgentCallbackContext>(
  value: unknown,
): value is { resolve: (context: TContext) => T | Promise<T> } {
  return isRecord(value) && typeof value.resolve === "function"
}

async function resolveMaybe<T, TContext extends AgentCallbackContext>(
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

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
}

async function hmacSha256(secret: string, value: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  )
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("")
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)])
  let diff = leftDigest.length ^ rightDigest.length
  for (let index = 0; index < Math.max(leftDigest.length, rightDigest.length); index += 1) {
    diff |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0)
  }
  return diff === 0
}

function webhookVerificationError(message: string): AgentHttpError {
  return new AgentHttpError(401, message)
}

export interface AgentWebhookVerificationOptions {
  requireSecretHeader?: boolean
}

async function verifyRequiredWebhookHeaders<TRuntimeConfig extends AgentRuntimeConfig>(
  registrations: AgentWebhookRegistrationDefinition<TRuntimeConfig>[],
  context: AgentCallbackContext<TRuntimeConfig>,
): Promise<AgentWebhookVerificationResult> {
  for (const registration of registrations) {
    const secretToken = await resolveMaybe(registration.secretToken, context)
    if (!registration.secretHeader) {
      if (secretToken === false) return { registration, verified: true }
      if (secretToken) {
        throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secretToken but no secretHeader is configured. Verification requires secretHeader; secretToken: false explicitly disables verification.`)
      }
      continue
    }
    if (secretToken === false) {
      return { registration, verified: true }
    }
    if (!secretToken) {
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secretHeader "${registration.secretHeader}" but no secretToken is configured. Verification requires secretToken from Server Env; secretToken: false explicitly disables verification.`)
    }
    throw webhookVerificationError(`[vitehub] Webhook secret header "${registration.secretHeader}" is required.`)
  }
  return { verified: true }
}

export async function verifyAgentWebhookRequest<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig>(
  registrations: AgentWebhookRegistrationDefinition<TRuntimeConfig>[],
  request: Request,
  context?: AgentCallbackContext<TRuntimeConfig>,
  options: AgentWebhookVerificationOptions = {},
): Promise<AgentWebhookVerificationResult> {
  const verificationContext = context ?? ({ runtime: "unknown" } as AgentCallbackContext<TRuntimeConfig>)
  const targeted = registrations
    .map(registration => ({
      headerValue: registration.secretHeader ? request.headers.get(registration.secretHeader) : null,
      registration,
    }))
    .filter((entry): entry is { headerValue: string, registration: AgentWebhookRegistrationDefinition } => entry.headerValue !== null)

  if (!targeted.length) {
    return options.requireSecretHeader
      ? await verifyRequiredWebhookHeaders(registrations, verificationContext)
      : { verified: true }
  }

  for (const { headerValue, registration } of targeted) {
    const secretToken = await resolveMaybe(registration.secretToken, verificationContext)
    if (secretToken === false) {
      return { registration, verified: true }
    }
    if (!secretToken) {
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secretHeader "${registration.secretHeader}" but no secretToken is configured. Verification requires secretToken from Server Env; secretToken: false explicitly disables verification.`)
    }
    if (registration.signature === "github-sha256") {
      const expected = `sha256=${await hmacSha256(secretToken, await request.clone().text())}`
      if (await constantTimeEqual(expected, headerValue)) {
        return { registration, verified: true }
      }
      continue
    }
    if (await constantTimeEqual(secretToken, headerValue)) {
      return { registration, verified: true }
    }
  }

  throw webhookVerificationError("[vitehub] Webhook secret verification failed.")
}

function requiresWebhookSecretHeader(registrations: AgentWebhookRegistrationDefinition[]) {
  return registrations.some(registration => registration.secretToken !== undefined && registration.secretToken !== false)
}

function withAgentTriggerContext<CALL_OPTIONS>(
  input: AgentRunInput<CALL_OPTIONS>,
  trigger: Pick<ResolvedAgentTriggerDefinition, "capabilityId" | "channelId" | "id" | "name" | "source">,
  delivery?: AgentTriggerRunInvokeResult<CALL_OPTIONS>["delivery"],
): AgentRunInput<CALL_OPTIONS> {
  const context = { ...input.context }
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
  options?: { verifyWebhook?: boolean },
): Promise<ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS>> {
  const triggers = await resolveAgentTriggers(agent, context)
  const trigger = triggers[triggerId] as ResolvedAgentTriggerDefinition<TRuntimeConfig, TInput, CALL_OPTIONS> | undefined
  if (!trigger) {
    throw new Error(`[vitehub] Agent trigger "${triggerId}" is not defined by this agent.`)
  }
  if (options?.verifyWebhook !== false && trigger.webhooks?.length && context.request) {
    await verifyAgentWebhookRequest(trigger.webhooks, context.request, createAgentCallbackContext(context), {
      requireSecretHeader: requiresWebhookSecretHeader(trigger.webhooks),
    })
  }
  return resolveAgentTriggerInvocationResult(await trigger.invoke(input), trigger)
}

export function resolveAgentTriggerInvocationResult<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  TInput = unknown,
  CALL_OPTIONS = unknown,
>(
  invocation: AgentTriggerInvokeResult<CALL_OPTIONS>,
  trigger: ResolvedAgentTriggerDefinition<TRuntimeConfig, TInput, CALL_OPTIONS>,
): ResolvedAgentTriggerInvocationResult<TRuntimeConfig, CALL_OPTIONS> {
  if (invocation instanceof Response) {
    return {
      response: invocation,
      trigger: trigger as never,
    }
  }
  return {
    input: withAgentTriggerContext(invocation.input, trigger, invocation.delivery),
    metadata: invocation.metadata,
    run: invocation.run,
    trigger: trigger as never,
    webhook: invocation.webhook,
  }
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
  const invocation = await resolveAgentTriggerInvocation<TRuntimeConfig, TInput, CALL_OPTIONS>(agent, context, triggerId, input)
  if (isResolvedAgentTriggerHandledInvocation(invocation)) return invocation.response
  return await executor(agent, { ...context, ...(invocation.run ? { run: invocation.run } : {}) }, invocation.input)
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
  const invocation = await resolveAgentTriggerInvocation<TRuntimeConfig, TInput, CALL_OPTIONS>(agent, context, triggerId, input)
  if (isResolvedAgentTriggerHandledInvocation(invocation)) return invocation.response
  await options.onInvocation?.(invocation)
  const output = options.output || (invocation.trigger.output === "ui-message-stream" ? "ui-message-stream" : "events")
  return await executor(agent, { ...context, ...(invocation.run ? { run: invocation.run } : {}) }, invocation.input, { output })
}
