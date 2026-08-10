import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { createAgentRuntimeContext } from "./context.ts"
import { workspaceAgentWithSourceRoot } from "../workspace-agent.ts"
import { decodeColocatedAgentHome, withColocatedAgentHome } from "../internal/colocated-agent-home.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"
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

function portableWorkflowValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  try {
    return structuredClone(value)
  }
  catch {}

  if (!value || typeof value !== "object") return unportableWorkflowValue
  const existing = seen.get(value)
  if (existing) return existing
  if (Array.isArray(value)) {
    const projected: unknown[] = []
    seen.set(value, projected)
    for (const item of value) {
      const portable = portableWorkflowValue(item, seen)
      projected.push(portable === unportableWorkflowValue ? undefined : portable)
    }
    return projected
  }

  const projected: Record<string, unknown> = {}
  seen.set(value, projected)
  for (const [key, item] of Object.entries(value)) {
    if (key === "raw") continue
    const portable = portableWorkflowValue(item, seen)
    if (portable !== unportableWorkflowValue) projected[key] = portable
  }
  return projected
}

async function portableWorkflowResult(result: unknown): Promise<unknown> {
  if (result instanceof Response) {
    const text = await result.text()
    return {
      raw: {
        headers: Object.fromEntries(result.headers),
        status: result.status,
        statusText: result.statusText,
      },
      text,
    } satisfies AgentRunResult
  }
  try {
    return structuredClone(result)
  }
  catch {
    const { raw: _raw, ...normalized } = toAgentRunResult(result)
    return portableWorkflowValue(normalized)
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
