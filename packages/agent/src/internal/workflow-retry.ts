import type { AgentRuntimeContext } from "../types.ts"

export const agentWorkflowRetryRegistrar = Symbol("vitehub.agent.workflow-retry-registrar")

type AgentWorkflowRetryContext = AgentRuntimeContext & {
  [agentWorkflowRetryRegistrar]?: (promise: Promise<unknown>) => void
}

export function registerAgentWorkflowRetry(context: AgentRuntimeContext, promise: Promise<unknown>): void {
  const register = (context as AgentWorkflowRetryContext)[agentWorkflowRetryRegistrar]
  if (register) {
    register(promise)
    return
  }
  context.waitUntil(Promise.resolve(promise).catch(() => undefined))
}
