import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { createAgentRuntimeContext } from "./context.ts"

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

const workflowRuntimeStateSpecifier = "@vite-hub/workflow/runtime/state"

export interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  agentIdentity?: AgentHostIdentity
  capabilities?: string[]
  input?: AgentRunInput<CALL_OPTIONS>
  run?: AgentRunMetadata
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

async function resolveWorkflowCapabilities(names: string[]): Promise<Record<string, unknown>> {
  const capabilities: Record<string, unknown> = {}
  for (const name of names) {
    if (name === "blob") capabilities.blob = (await import("@vite-hub/blob")).blob
    else if (name === "kv") capabilities.kv = (await import("@vite-hub/kv")).kv
    else if (name === "schedule") capabilities.schedule = { schedules: (await import("@vite-hub/schedule")).schedules }
  }
  return capabilities
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
  const { getWorkflowRuntimeEvent } = await import(/* @vite-ignore */ workflowRuntimeStateSpecifier)
  const cloudflareEnv = context.provider === "cloudflare"
    ? getActiveCloudflareEnv() || getCloudflareEnv(getWorkflowRuntimeEvent())
    : undefined
  const capabilities = await resolveWorkflowCapabilities(payload.capabilities || [])
  const runtimeContext = createAgentRuntimeContext<TRuntimeConfig>({
    ...(payload.agentIdentity ? { agentIdentity: payload.agentIdentity } : {}),
    ...(cloudflareEnv ? { cloudflare: { env: cloudflareEnv } } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(payload.run || context.id
      ? { run: payload.run || { origin: `workflow:${context.provider}`, runId: context.id! } }
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
