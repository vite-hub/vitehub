import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { createAgentRuntimeContext } from "./context.ts"
import { workspaceAgentWithSourceRoot } from "../workspace-agent.ts"
import { decodeColocatedAgentHome, withColocatedAgentHome } from "../internal/colocated-agent-home.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"
import { workflowBytesToBase64 } from "../internal/workflow-portability.ts"
import { restoreResolvedAgentInvokerInput } from "../invoker.ts"
import { toAgentRunResult } from "../agent-output.ts"

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
  if (typeof value === "number") return Number.isFinite(value)
  if (!value || typeof value !== "object" || seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) return value.every(item => item === undefined || isJsonWorkflowValue(item, seen))
  if (value instanceof Map || value instanceof Set || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false
  if (value instanceof Date) return false
  return Object.values(value).every(item => item === undefined || isJsonWorkflowValue(item, seen))
}

function jsonWorkflowValue(value: unknown): unknown | typeof unportableWorkflowValue {
  if (!isJsonWorkflowValue(value)) return unportableWorkflowValue
  try {
    const serialized = JSON.stringify(value)
    return serialized === undefined ? unportableWorkflowValue : JSON.parse(serialized)
  }
  catch {
    return unportableWorkflowValue
  }
}

function isTextResponseMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("text/")
    || /^(?:application\/(?:[^;]+\+)?(?:json|xml|yaml|javascript)|image\/svg\+xml)(?:;|$)/i.test(mediaType)
}

function portableWorkflowValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : unportableWorkflowValue
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
  if (!result || typeof result !== "object" || !agentResultKeys.some(key => key in result)) {
    const error = new TypeError("Agent Workflow results must contain only JSON-compatible values.") as TypeError & { isRetryable: false }
    error.isRetryable = false
    throw error
  }
  const projected = "raw" in result ? portableWorkflowValue(result) : portableWorkflowValue(toAgentRunResult(result))
  const jsonProjected = jsonWorkflowValue(projected)
  if (jsonProjected !== unportableWorkflowValue) return jsonProjected
  const { raw: _raw, ...normalized } = toAgentRunResult(result)
  return portableWorkflowValue(normalized)
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
  const runtimeContext = createAgentRuntimeContext<TRuntimeConfig>({
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

  return await portableWorkflowResult(await runAgentInline(
    agent,
    runtimeContext,
    payload.resolvedInvoker
      ? restoreResolvedAgentInvokerInput((payload.input ?? {}) as AgentRunInput<CALL_OPTIONS>)
      : (payload.input ?? {}) as AgentRunInput<CALL_OPTIONS>,
  ))
}
