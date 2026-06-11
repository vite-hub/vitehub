import { normalizeCapabilities } from "./capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentWebhookRegistrationDefinition,
  MaybePromise,
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
  return (workspaceOptions?.capabilities || agent.capabilities || []) as AgentCapabilityDefinition<TRuntimeConfig>[]
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
        devtools: trigger.devtools,
        id,
        input: trigger.input,
        invoke: input => trigger.invoke({
          ...runtimeContext,
          capability,
          trigger: {
            capabilityId: capability.id,
            id,
            name,
          },
        }, input as never),
        name,
        output: trigger.output,
        webhooks: trigger.webhooks,
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
}

export interface AgentWebhookVerificationResult {
  registration?: AgentWebhookRegistrationDefinition
  verified: boolean
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256(left), sha256(right)])
  let diff = leftDigest.length ^ rightDigest.length
  for (let index = 0; index < Math.max(leftDigest.length, rightDigest.length); index += 1) {
    diff |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0)
  }
  return diff === 0
}

function webhookVerificationError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 401 })
}

export async function verifyAgentWebhookRequest(
  registrations: AgentWebhookRegistrationDefinition[],
  request: Request,
): Promise<AgentWebhookVerificationResult> {
  const targeted = registrations
    .map(registration => ({
      headerValue: registration.secretHeader ? request.headers.get(registration.secretHeader) : null,
      registration,
    }))
    .filter((entry): entry is { headerValue: string, registration: AgentWebhookRegistrationDefinition } => entry.headerValue !== null)

  if (!targeted.length) return { verified: true }

  for (const { headerValue, registration } of targeted) {
    if (registration.secretToken === false) {
      return { registration, verified: true }
    }
    if (!registration.secretToken) {
      throw webhookVerificationError(`[vitehub] Webhook registration "${registration.id || registration.provider}" declares secretHeader "${registration.secretHeader}" but no secretToken is configured. Set secretToken (from Server Env) or secretToken: false to explicitly disable verification.`)
    }
    if (await constantTimeEqual(registration.secretToken, headerValue)) {
      return { registration, verified: true }
    }
  }

  throw webhookVerificationError("[vitehub] Webhook secret verification failed.")
}

function withAgentTriggerContext<CALL_OPTIONS>(
  input: AgentRunInput<CALL_OPTIONS>,
  trigger: Pick<ResolvedAgentTriggerDefinition, "capabilityId" | "id" | "name">,
): AgentRunInput<CALL_OPTIONS> {
  return {
    ...input,
    context: {
      ...input.context,
      [agentTriggerContextKey]: {
        capabilityId: trigger.capabilityId,
        id: trigger.id,
        name: trigger.name,
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
): Promise<ResolvedAgentTriggerInvocation<TRuntimeConfig, CALL_OPTIONS>> {
  const triggers = await resolveAgentTriggers(agent, context)
  const trigger = triggers[triggerId] as ResolvedAgentTriggerDefinition<TRuntimeConfig, TInput, CALL_OPTIONS> | undefined
  if (!trigger) {
    throw new Error(`[vitehub] Agent trigger "${triggerId}" is not defined by this agent.`)
  }
  if (trigger.webhooks?.length && context.request) {
    await verifyAgentWebhookRequest(trigger.webhooks, context.request)
  }
  const invocation = await trigger.invoke(input)
  return {
    input: withAgentTriggerContext(invocation.input, trigger),
    metadata: invocation.metadata,
    run: invocation.run,
    trigger: trigger as never,
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
  await options.onInvocation?.(invocation)
  const output = options.output || (invocation.trigger.output === "ui-message-stream" ? "ui-message-stream" : "events")
  return await executor(agent, { ...context, ...(invocation.run ? { run: invocation.run } : {}) }, invocation.input, { output })
}
