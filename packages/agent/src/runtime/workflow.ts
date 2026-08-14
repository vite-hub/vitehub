import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { createAgentRuntimeContext } from "./context.ts"
import { workspaceAgentWithSourceRoot } from "../workspace-agent.ts"
import { decodeColocatedAgentHome, withColocatedAgentHome } from "../internal/colocated-agent-home.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"
import { cloneWorkflowJsonValue, workflowBytesToBase64 } from "../internal/workflow-portability.ts"
import { restoreResolvedAgentInvokerInput } from "../invoker.ts"
import { toAgentRunResult } from "../agent-output.ts"
import { agentChannelDeliveryWorkflowContextKey, withAgentChannelDelivery } from "../internal/channel-delivery.ts"

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

export function agentWithColocatedHome<Agent>(agent: Agent, files: Parameters<typeof decodeColocatedAgentHome>[0]): Agent {
  return withColocatedAgentHome(agent, decodeColocatedAgentHome(files))
}

export interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  agentIdentity?: AgentHostIdentity
  capabilities?: Record<string, false>
  input?: AgentRunInput<CALL_OPTIONS>
  requestUrl?: string
  resolvedInvoker?: boolean
  run?: Partial<AgentRunMetadata>
  runtime?: AgentRuntimeName
  runtimeConfig?: AgentRuntimeConfig
}

export type AgentWorkflowRunner<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
> = (
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
  input: AgentRunInput<CALL_OPTIONS>,
) => Promise<Response | AgentRunResult | unknown>

function agentRuntimeFromWorkflowProvider(provider: WorkflowProvider): AgentRuntimeName {
  if (provider === "cloudflare") return "cloudflare-agents"
  if (provider === "vercel") return "vercel"
  return "unknown"
}

function waitUntil(promise: Promise<unknown>): void {
  void Promise.resolve(promise).catch(() => {})
}

const unportableWorkflowValue = Symbol("vitehub.agent.unportable-workflow-value")

function isJsonWorkflowValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0)
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (Reflect.ownKeys(value).some(key => typeof key === "symbol")) return false
  seen.add(value)
  let portable = false
  if (Array.isArray(value)) {
    portable = value.length === Object.keys(value).length
      && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) && value[index] !== undefined && isJsonWorkflowValue(value[index], seen)).every(Boolean)
  }
  else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
    portable = Object.values(value).every(item => item !== undefined && isJsonWorkflowValue(item, seen))
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
  }
  catch {
    return unportableWorkflowValue
  }
}

function unsupportedWorkflowResult(): never {
  const error = new TypeError("Agent Workflow results must contain only JSON-compatible values.") as TypeError & { isRetryable: false }
  error.isRetryable = false
  throw error
}

function isTextResponseMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("text/")
    || /^(?:application\/(?:[^;]+\+)?(?:json|xml|yaml|javascript)|image\/svg\+xml)(?:;|$)/i.test(mediaType)
}

function portableWorkflowValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0) ? value : unportableWorkflowValue
  if (!value || typeof value !== "object") return unportableWorkflowValue
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
  if (!result || typeof result !== "object" || !agentResultKeys.some(key => key in result)) unsupportedWorkflowResult()
  if (!Object.keys(result).every(key => agentResultKeys.includes(key) || providerResultKeys.includes(key))) unsupportedWorkflowResult()
  if (Object.hasOwn(result, "initialResponseMessages")) {
    const prototype = Object.getPrototypeOf(result)
    const aiSdkTextResultGetterKeys = ["content", "finalStep", "text"]
    if (!aiSdkTextResultMarkerKeys.every(key => Object.hasOwn(result, key)) || !aiSdkTextResultGetterKeys.every(key => typeof Object.getOwnPropertyDescriptor(prototype, key)?.get === "function")) unsupportedWorkflowResult()
  }
  if (!providerResultMarkerKeys.some(key => key in result) && !normalizedAgentResultKeys.every(key => Object.hasOwn(result, key))) unsupportedWorkflowResult()
  const normalizedResult = toAgentRunResult(result)
  if (Object.hasOwn(result, "initialResponseMessages")) {
    const { initialResponseMessages: _initialResponseMessages, ...raw } = result as Record<string, unknown>
    normalizedResult.finishReason = (result as Record<string, unknown>).finishReason
    normalizedResult.raw = raw
    normalizedResult.warnings = (result as Record<string, unknown>).warnings
  }
  const projected = "raw" in result ? portableWorkflowValue(result) : portableWorkflowValue(normalizedResult)
  const jsonProjected = jsonWorkflowValue(projected)
  if (jsonProjected !== unportableWorkflowValue) return jsonProjected
  const { raw: _raw, ...normalized } = toAgentRunResult(result)
  const portable = portableWorkflowValue(normalized)
  if (jsonWorkflowValue(portable) === unportableWorkflowValue) unsupportedWorkflowResult()
  return portable
  }
  catch (error) {
    if (error && typeof error === "object" && (error as { isRetryable?: unknown }).isRetryable === false) throw error
    unsupportedWorkflowResult()
  }
}

export async function runAgentWorkflowDefinition<
  TRuntimeConfig extends AgentRuntimeConfig = AgentRuntimeConfig,
  CALL_OPTIONS = unknown,
>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: WorkflowExecutionContext<AgentWorkflowInvocationPayload<CALL_OPTIONS> | undefined>,
  runAgentInline: AgentWorkflowRunner<TRuntimeConfig, CALL_OPTIONS>,
): Promise<Response | AgentRunResult | unknown> {
  const payload = context.payload || {}
  const { getWorkflowRuntimeEvent } = await loadAgentWorkflowRuntimeStateModule()
  const cloudflareEnv = context.provider === "cloudflare"
    ? getActiveCloudflareEnv() || getCloudflareEnv(getWorkflowRuntimeEvent())
    : undefined
  const runId = context.id || payload.run?.runId
  let runtimeContext = createAgentRuntimeContext<TRuntimeConfig>({
    ...(payload.agentIdentity ? { agentIdentity: payload.agentIdentity } : {}),
    ...(payload.capabilities ? { capabilities: payload.capabilities } : {}),
    ...(cloudflareEnv ? { cloudflare: { env: cloudflareEnv } } : {}),
    ...(payload.requestUrl ? { request: new Request(payload.requestUrl) } : {}),
    ...(runId
      ? { run: { origin: `workflow:${context.provider}`, ...payload.run, runId } }
      : {}),
    runtime: payload.runtime || agentRuntimeFromWorkflowProvider(context.provider),
    runtimeConfig: (payload.runtimeConfig || {}) as TRuntimeConfig,
    waitUntil,
  } as never)

  const channelDeliveryBinding = payload.input?.context?.[agentChannelDeliveryWorkflowContextKey]
  const channelDelivery = isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding)
    ? await (await import("../server/routes.ts")).resumeWorkflowAgentChannelDelivery(
        agent as never,
        runtimeContext as never,
        channelDeliveryBinding,
      )
    : undefined
  if (isAgentChannelDeliveryWorkflowBinding(channelDeliveryBinding) && !channelDelivery) {
    throw new Error(`[vitehub] Durable Agent Channel delivery "${channelDeliveryBinding.deliveryId}" could not be resumed.`)
  }
  if (channelDelivery) runtimeContext = withAgentChannelDelivery(runtimeContext, channelDelivery)

  try {
    const result = await portableWorkflowResult(await runAgentInline(
      agent,
      runtimeContext,
      payload.resolvedInvoker
        ? restoreResolvedAgentInvokerInput((payload.input ?? {}) as AgentRunInput<CALL_OPTIONS>)
        : (payload.input ?? {}) as AgentRunInput<CALL_OPTIONS>,
    ))
    if (channelDelivery) {
      await channelDelivery.event({ type: "invocation.completed", runId }).catch(() => undefined)
      await channelDelivery.event({ type: "completed", runId }).catch(() => undefined)
    }
    return result
  }
  catch (error) {
    if (channelDelivery) {
      await channelDelivery.event({ error: error instanceof Error ? error.message : String(error), type: "invocation.failed", runId }).catch(() => undefined)
      await channelDelivery.event({ error: error instanceof Error ? error.message : String(error), type: "failed", runId }).catch(() => undefined)
    }
    throw error
  }
}

function isAgentChannelDeliveryWorkflowBinding(value: unknown): value is AgentChannelDeliveryWorkflowBinding {
  return Boolean(value && typeof value === "object"
    && typeof (value as AgentChannelDeliveryWorkflowBinding).channelId === "string"
    && typeof (value as AgentChannelDeliveryWorkflowBinding).deliveryId === "string"
    && typeof (value as AgentChannelDeliveryWorkflowBinding).provider === "string")
}
