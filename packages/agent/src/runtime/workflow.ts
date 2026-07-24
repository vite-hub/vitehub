import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { createAgentRuntimeContext } from "./context.ts"
import { workspaceAgentWithSourceRoot } from "../workspace-agent.ts"
import { decodeColocatedAgentHome, withColocatedAgentHome } from "../internal/colocated-agent-home.ts"
import { decodeColocatedAgentSkills, withColocatedAgentSkills } from "../internal/colocated-agent-skills.ts"
import { loadAgentWorkflowRuntimeStateModule } from "../internal/workflow-runtime-loaders.ts"

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
    ...(runId
      ? { run: { origin: `workflow:${context.provider}`, ...payload.run, runId } }
      : {}),
    runtime: payload.runtime || agentRuntimeFromWorkflowProvider(context.provider),
    runtimeConfig: (payload.runtimeConfig || {}) as TRuntimeConfig,
    waitUntil,
  } as never)

  return await runAgentInline(
    agent,
    runtimeContext,
    (payload.input ?? {}) as AgentRunInput<CALL_OPTIONS>,
  )
}
