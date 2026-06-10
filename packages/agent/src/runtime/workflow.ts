import { getActiveCloudflareEnv, getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getWorkflowRuntimeEvent } from "@vite-hub/workflow/runtime/state"

import { createAgentRuntimeContext } from "./context.ts"

import type {
  AgentInput,
  AgentRunInput,
  AgentRunMetadata,
  AgentRuntimeConfig,
  AgentRuntimeName,
} from "../types.ts"
import type { WorkflowExecutionContext, WorkflowProvider } from "@vite-hub/workflow"

export interface AgentWorkflowInvocationPayload<CALL_OPTIONS = unknown> {
  input?: AgentRunInput<CALL_OPTIONS>
  run?: AgentRunMetadata
  runtime?: AgentRuntimeName
}

export type AgentWorkflowRunner = (
  agent: any,
  context: any,
  input: any,
) => Promise<Response | unknown>

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
  agent: AgentInput,
  context: WorkflowExecutionContext<AgentWorkflowInvocationPayload<CALL_OPTIONS> | undefined>,
  runAgentInline: AgentWorkflowRunner,
): Promise<Response | unknown> {
  const payload = context.payload || {}
  const cloudflareEnv = context.provider === "cloudflare"
    ? getActiveCloudflareEnv() || getCloudflareEnv(getWorkflowRuntimeEvent())
    : undefined
  const runtimeContext = createAgentRuntimeContext<TRuntimeConfig>({
    ...(cloudflareEnv ? { cloudflare: { env: cloudflareEnv } } : {}),
    ...(payload.run || context.id
      ? { run: payload.run || { origin: `workflow:${context.provider}`, runId: context.id! } }
      : {}),
    runtime: payload.runtime || agentRuntimeFromWorkflowProvider(context.provider),
    waitUntil,
  } as never)

  return await runAgentInline(
    agent,
    runtimeContext,
    payload.input || {},
  )
}
