import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getViteHubErrorShape } from "@vite-hub/runtime"

import { createAgentRuntimeContext } from "./context.ts"
import { workspaceAgentWithSourceRoot } from "../workspace-agent.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { loadAgentWorkflowModule, loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"
import { agentInvocationRunId } from "../invocation-context.ts"
import { agentInvocationRecoveryTasks } from "../internal/invocation-recovery.ts"
import { bindAgentInvocations } from "../invocations.ts"
import { cloneWorkflowJsonValue, workflowBytesToBase64 } from "../internal/workflow-portability.ts"
import { restoreResolvedAgentInvokerInput } from "../invoker.ts"
import { toAgentRunResult } from "../agent-output.ts"
import { readAgentErrorProperty, toAgentPublicError } from "../agent-error.ts"
import {
  agentChannelDeliveryWorkflowContextKey,
  resumeAgentChannelDeliveryWorkflowOwnership,
  resumeWorkflowAgentChannelDelivery,
  withAgentChannelDelivery,
} from "../internal/channel-delivery.ts"
import { agentWorkflowExecutionContextKey } from "../internal/workflow-execution.ts"
import { isRuntimeBoolean, isRuntimeFunction, isRuntimeNumber, isRuntimeObject, isRuntimeString, isRuntimeSymbol } from "../internal/runtime-value.ts"

import type {
  AgentHostIdentity,
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRunResult,
  AgentRuntimeConfig,
  AgentRuntimeContext,
  AgentRuntimeName,
} from "../types.ts"

import type { WorkflowExecutionContext, WorkflowProvider } from "@vite-hub/workflow"
import type { AgentChannelDeliveryWorkflowBinding } from "../internal/channel-delivery.ts"

export { workspaceAgentWithSourceRoot }

export function agentWithColocatedSkills<Agent>(agent: Agent, sources: Parameters<typeof decodeColocatedAgentSkills>[0]): Agent {
  return withColocatedAgentSkills(agent, decodeColocatedAgentSkills(sources))
}

export interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  agentIdentity?: AgentHostIdentity
  capabilities?: Record<string, false>
  input?: AgentRunInput<CALL_OPTIONS>
  invocationRecovery?: {
    agentName?: string
    runId: string
    sourceRunId: string
    workflowName: string
  }
  requestUrl?: string
  resolvedInvoker?: boolean
  run?: Partial<AgentRunMetadata>
  trace?: AgentRuntimeContext["trace"]
  runtime?: AgentRuntimeName
  runtimeConfig?: AgentRuntimeConfig
}

function workflowRecoveryDelay(attempt: number): { duration: string; milliseconds: number } {
  if (attempt < 60) return { duration: "1 second", milliseconds: 1_000 }
  if (attempt < 120) return { duration: "1 minute", milliseconds: 60_000 }
  return { duration: "30 minutes", milliseconds: 1_800_000 }
}

async function sleepForWorkflowRecovery(context: WorkflowExecutionContext, attempt: number): Promise<void> {
  const delay = workflowRecoveryDelay(attempt)
  if (context.step?.sleep) return await context.step.sleep(`agent-invocation-recovery-${attempt + 1}`, delay.duration)
  await new Promise<void>((resolve) => setTimeout(resolve, delay.milliseconds))
}

async function reconcileAgentWorkflowInvocation<TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: WorkflowExecutionContext,
  runtimeContext: AgentRuntimeContext<TRuntimeConfig>,
  recovery: NonNullable<AgentWorkflowInvocationPayload["invocationRecovery"]>,
): Promise<void> {
  if (!agent || !isRuntimeObject(agent) || !("invocations" in agent)) return
  const invocations = agent.invocations
  if (!invocations) return
  const journal = await bindAgentInvocations(
    invocations,
    {
      ...runtimeContext,
      run: { ...runtimeContext.run, runId: recovery.sourceRunId },
    },
    { agentName: recovery.agentName, deferClaim: true, terminalTakeover: true },
  )
  if (!journal) return
  const { getWorkflowRun } = await loadAgentWorkflowModule()
  // ponytail: Recovery is bounded to one day; add provider events or re-enqueueing if runs routinely exceed it.
  for (let attempt = 0; attempt < 166; attempt++) {
    try {
      const run = await getWorkflowRun(recovery.workflowName, recovery.runId)
      if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
        await journal.finish(run.status, run.status === "failed" ? run.metadata : undefined)
        await Promise.all(agentInvocationRecoveryTasks(runtimeContext))
        const record = await invocations.getByRunId(recovery.sourceRunId, recovery.agentName)
        if (record?.status === run.status) return
      }
    } catch {}
    if (attempt < 165) await sleepForWorkflowRecovery(context, attempt)
  }
}

export type AgentWorkflowRunner<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown> = (
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
) => Promise<Response | AgentRunResult | unknown>

function agentRuntimeFromWorkflowProvider(provider: WorkflowProvider): AgentRuntimeName {
  if (provider === "cloudflare") return "cloudflare-agents"
  if (provider === "vercel") return "vercel"
  return "unknown"
}

const unportableWorkflowValue = Symbol("vitehub.agent.unportable-workflow-value")

function isJsonWorkflowValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || isRuntimeString(value) || isRuntimeBoolean(value)) return true
  if (isRuntimeNumber(value)) return Number.isFinite(value) && !Object.is(value, -0)
  if (!value || !isRuntimeObject(value) || seen.has(value)) return false
  if (Reflect.ownKeys(value).some((key) => isRuntimeSymbol(key))) return false
  seen.add(value)
  let portable = false
  if (Array.isArray(value)) {
    portable =
      value.length === Object.keys(value).length &&
      Array.from(
        { length: value.length },
        (_, index) => Object.hasOwn(value, index) && value[index] !== undefined && isJsonWorkflowValue(value[index], seen),
      ).every(Boolean)
  } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    portable = Object.values(value).every((item) => item !== undefined && isJsonWorkflowValue(item, seen))
  }
  seen.delete(value)
  return portable
}

function jsonWorkflowValue(value: unknown): unknown | typeof unportableWorkflowValue {
  try {
    const cloned = cloneWorkflowJsonValue(value, { omitUndefinedObjectProperties: false })
    if (!isJsonWorkflowValue(cloned)) return unportableWorkflowValue
    const serialized = JSON.stringify(cloned)
    return serialized === undefined ? unportableWorkflowValue : JSON.parse(serialized)
  } catch {
    return unportableWorkflowValue
  }
}

function unsupportedWorkflowResult(): never {
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  const error = new TypeError("Agent Workflow results must contain only JSON-compatible values.") as TypeError & { isRetryable: false }
  error.isRetryable = false
  throw error
}

function nonRetryableAgentWorkflowError(error: unknown): unknown {
  if (readAgentErrorProperty(error, "isRetryable") === false) return error
  const nestedNonRetryable =
    error instanceof AggregateError &&
    error.errors.some((candidate) => readAgentErrorProperty(nonRetryableAgentWorkflowError(candidate), "isRetryable") === false)
  const code = getViteHubErrorShape(error)?.code
  const publicError = toAgentPublicError(error, "invocation")
  const terminalProvider = publicError.code === "PROVIDER_AUTHENTICATION_FAILED" || publicError.code === "PROVIDER_QUOTA_EXHAUSTED"
  const retry = readAgentErrorProperty(error, "name") === "AI_RetryError" ? readAgentErrorProperty(error, "lastError") : error
  const exhaustedProviderRetries = retry !== error
  const name = readAgentErrorProperty(retry, "name")
  const status = readAgentErrorProperty(retry, "statusCode")
  const permanentProviderRequest =
    name === "AI_LoadAPIKeyError" ||
    (name === "AI_APICallError" && isRuntimeNumber(status) && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status))
  const exhaustedOutput = code === "AGENT_OUTPUT_INVALID_JSON" || code === "AGENT_OUTPUT_SCHEMA_INVALID" || name === "AI_NoObjectGeneratedError"
  if (!nestedNonRetryable && !terminalProvider && !permanentProviderRequest && !exhaustedProviderRetries && !exhaustedOutput) return error

  const value = error instanceof Error ? error : new Error(String(error), { cause: error })
  try {
    Object.defineProperty(value, "isRetryable", { configurable: true, value: false })
    return value
  } catch {
    return Object.assign(new Error(value.message, { cause: value }), {
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      isRetryable: false as const,
    })
  }
}

function isTextResponseMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("text/") || /^(?:application\/(?:[^;]+\+)?(?:json|xml|yaml|javascript)|image\/svg\+xml)(?:;|$)/i.test(mediaType)
}

function portableWorkflowValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || isRuntimeString(value) || isRuntimeBoolean(value)) return value
  if (isRuntimeNumber(value)) return Number.isFinite(value) && !Object.is(value, -0) ? value : unportableWorkflowValue
  if (!value || !isRuntimeObject(value)) return unportableWorkflowValue
  if (value instanceof Map || value instanceof Set || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return unportableWorkflowValue
  if (value instanceof Date) return unportableWorkflowValue
  if (seen.has(value)) return unportableWorkflowValue
  if (Array.isArray(value)) {
    const projected: unknown[] = []
    seen.set(value, projected)
    for (const item of value) {
      const portable = portableWorkflowValue(item, seen)
      projected.push(portable === unportableWorkflowValue ? undefined : portable)
    }
    seen.delete(value)
    return projected
  }

  const projected: Record<string, unknown> = {}
  seen.set(value, projected)
  for (const [key, item] of Object.entries(value)) {
    const portable = portableWorkflowValue(item, seen)
    if (portable !== unportableWorkflowValue) projected[key] = portable
  }
  seen.delete(value)
  return Object.keys(projected).length || Object.keys(value).length === 0 ? projected : unportableWorkflowValue
}

async function portableWorkflowResult(result: unknown): Promise<unknown> {
  try {
    if (result instanceof Response) {
      const headers = Array.from(result.headers)
      const mediaType = result.headers.get("content-type") || "application/octet-stream"
      const bytes = new Uint8Array(await result.arrayBuffer())
      return {
        raw: {
          body: { data: workflowBytesToBase64(bytes), encoding: "base64", mediaType },
          headers,
          status: result.status,
          statusText: result.statusText,
        },
        ...(isTextResponseMediaType(mediaType) ? { text: new TextDecoder().decode(bytes) } : {}),
      } satisfies AgentRunResult
    }
    const jsonResult = jsonWorkflowValue(result)
    if (jsonResult !== unportableWorkflowValue) return jsonResult
    const agentResultKeys = ["artifacts", "finishReason", "raw", "text", "usage", "usageRecord", "warnings"]
    const providerResultMarkerKeys = ["_output", "content", "output", "provider", "steps", "totalUsage"]
    const aiSdkTextResultMarkerKeys = ["_output", "steps", "totalUsage"]
    const providerResultKeys = [...providerResultMarkerKeys, "initialResponseMessages"]
    const normalizedAgentResultKeys = ["finishReason", "raw", "text", "usage", "usageRecord", "warnings"]
    if (!result || !isRuntimeObject(result) || !agentResultKeys.some((key) => key in result)) unsupportedWorkflowResult()
    if (!Object.keys(result).every((key) => agentResultKeys.includes(key) || providerResultKeys.includes(key))) unsupportedWorkflowResult()
    if (Object.hasOwn(result, "initialResponseMessages")) {
      const prototype = Object.getPrototypeOf(result)
      const aiSdkTextResultGetterKeys = ["content", "finalStep", "text"]
      if (
        !aiSdkTextResultMarkerKeys.every((key) => Object.hasOwn(result, key)) ||
        !aiSdkTextResultGetterKeys.every((key) => isRuntimeFunction(Object.getOwnPropertyDescriptor(prototype, key)?.get))
      )
        unsupportedWorkflowResult()
    }
    if (!providerResultMarkerKeys.some((key) => key in result) && !normalizedAgentResultKeys.every((key) => Object.hasOwn(result, key)))
      unsupportedWorkflowResult()
    const normalizedResult = toAgentRunResult(result)
    if (Object.hasOwn(result, "initialResponseMessages")) {
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      const { initialResponseMessages: _initialResponseMessages, ...raw } = result as Record<string, unknown>
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      normalizedResult.finishReason = (result as Record<string, unknown>).finishReason
      normalizedResult.raw = raw
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      normalizedResult.warnings = (result as Record<string, unknown>).warnings
    }
    const projected = "raw" in result ? portableWorkflowValue(result) : portableWorkflowValue(normalizedResult)
    const jsonProjected = jsonWorkflowValue(projected)
    if (jsonProjected !== unportableWorkflowValue) return jsonProjected
    const { raw: _raw, ...normalized } = toAgentRunResult(result)
    const portable = portableWorkflowValue(normalized)
    if (jsonWorkflowValue(portable) === unportableWorkflowValue) unsupportedWorkflowResult()
    return portable
  } catch (error) {
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    if (error && isRuntimeObject(error) && (error as { isRetryable?: unknown }).isRetryable === false) throw error
    unsupportedWorkflowResult()
  }
}

export async function runAgentWorkflowDefinition<TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig, CALL_OPTIONS = unknown>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: WorkflowExecutionContext<AgentWorkflowInvocationPayload<CALL_OPTIONS> | undefined>,
  runAgentInline: AgentWorkflowRunner<TRuntimeConfig, CALL_OPTIONS>,
): Promise<Response | AgentRunResult | unknown> {
  const payload = context.payload || {}
  const waitUntil = (promise: Promise<unknown>): void => {
    void Promise.resolve(promise).catch(() => {})
  }
  const { getWorkflowRuntimeEvent } = await loadAgentWorkflowRuntimeStateModule()
  const cloudflareEnv = context.provider === "cloudflare" ? getActiveCloudflareEnv() || getCloudflareEnv(getWorkflowRuntimeEvent()) : undefined
  const runId = context.id || payload.run?.runId
  const backgroundTasks: Promise<unknown>[] = []
  // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
  let runtimeContext = createAgentRuntimeContext<TRuntimeConfig>({
    ...(payload.agentIdentity ? { agentIdentity: payload.agentIdentity } : {}),
    ...(payload.capabilities ? { capabilities: payload.capabilities } : {}),
    ...(cloudflareEnv ? { cloudflare: { env: cloudflareEnv } } : {}),
    ...(payload.requestUrl ? { request: new Request(payload.requestUrl) } : {}),
    ...(runId ? { run: { origin: `workflow:${context.provider}`, ...payload.run, runId } } : {}),
    ...(payload.trace ? { trace: payload.trace } : {}),
    runtime: payload.runtime || agentRuntimeFromWorkflowProvider(context.provider),
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    runtimeConfig: (payload.runtimeConfig || {}) as TRuntimeConfig,
    waitUntil(promise: Promise<unknown>) {
      backgroundTasks.push(Promise.resolve(promise).catch(() => undefined))
    },
  } as never)
  if (payload.run?.runId && payload.run.runId !== runId) {
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    ;(runtimeContext as AgentRuntimeContext<TRuntimeConfig> & { [agentInvocationRunId]: string })[agentInvocationRunId] = payload.run.runId
  }

  Object.defineProperty(runtimeContext, agentWorkflowExecutionContextKey, {
    enumerable: true,
    value: true,
  })

  if (payload.invocationRecovery) {
    await reconcileAgentWorkflowInvocation(agent, context, runtimeContext, payload.invocationRecovery)
    return
  }

  const channelDeliveryBinding = payload.input?.context?.[agentChannelDeliveryWorkflowContextKey]
  const channelDelivery = isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding)
    ? // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      await resumeWorkflowAgentChannelDelivery(agent as never, runtimeContext as never, channelDeliveryBinding)
    : undefined
  if (isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding) && !channelDelivery) {
    throw new Error(`[vitehub] Durable Agent Channel delivery "${channelDeliveryBinding.deliveryId}" could not be resumed.`)
  }
  if (channelDelivery) runtimeContext = withAgentChannelDelivery(runtimeContext, channelDelivery)
  const channelOwnership = isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding)
    ? await resumeAgentChannelDeliveryWorkflowOwnership(agent, runtimeContext, channelDeliveryBinding)
    : undefined
  const workflowInput = channelOwnership?.abortSignal
    ? {
        ...payload.input,
        abortSignal: payload.input?.abortSignal ? AbortSignal.any([payload.input.abortSignal, channelOwnership.abortSignal]) : channelOwnership.abortSignal,
      }
    : (payload.input ?? {})

  let channelDeliveryStatus: "completed" | "failed" = "failed"
  try {
    if (channelOwnership?.settlementStatus) {
      channelDeliveryStatus = channelOwnership.settlementStatus
      return
    }
    if (channelDelivery) await channelDelivery.event({ type: "invocation.started", runId }).catch(() => undefined)
    const inlineResult = await runAgentInline(
      agent,
      runtimeContext,
      // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
      payload.resolvedInvoker ? restoreResolvedAgentInvokerInput(workflowInput as AgentRunInput<CALL_OPTIONS>) : (workflowInput as AgentRunInput<CALL_OPTIONS>),
    )
    channelOwnership?.abortSignal?.throwIfAborted()
    const result = await portableWorkflowResult(inlineResult)
    if (channelDelivery && !channelOwnership?.abortSignal?.aborted) {
      await channelDelivery.event({ type: "invocation.completed", runId }).catch(() => undefined)
      await channelDelivery.event({ type: "completed", runId }).catch(() => undefined)
    }
    channelDeliveryStatus = "completed"
    return result
  } catch (error) {
    if (channelDelivery && !channelOwnership?.abortSignal?.aborted) {
      await channelDelivery
        .event({
          error: error instanceof Error ? error.message : String(error),
          type: "invocation.failed",
          runId,
        })
        .catch(() => undefined)
      await channelDelivery
        .event({
          error: error instanceof Error ? error.message : String(error),
          type: "failed",
          runId,
        })
        .catch(() => undefined)
    }
    throw nonRetryableAgentWorkflowError(error)
  } finally {
    while (backgroundTasks.length) {
      await Promise.allSettled(backgroundTasks.splice(0))
    }
    await channelOwnership?.settle(channelDeliveryStatus).catch(() => undefined)
  }
}

function isAgentChannelDeliveryWorkflowBinding(value: unknown): value is AgentChannelDeliveryWorkflowBinding {
  return Boolean(
    value &&
    isRuntimeObject(value) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    (isRuntimeString((value as AgentChannelDeliveryWorkflowBinding).channelId) || (value as AgentChannelDeliveryWorkflowBinding).channelId === undefined) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    isRuntimeString((value as AgentChannelDeliveryWorkflowBinding).deliveryId) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    isRuntimeString((value as AgentChannelDeliveryWorkflowBinding).provider) &&
    // SAFETY: The owning Agent runtime boundary establishes the asserted representation before this value is used.
    ((value as AgentChannelDeliveryWorkflowBinding).state === "chat" || (value as AgentChannelDeliveryWorkflowBinding).state === "webhook"),
  )
}
