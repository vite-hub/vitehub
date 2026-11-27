import { createD1AgentInvocationStore, createLibsqlAgentInvocationStore } from "vite-hub/agent/invocations"
import { getAgent, loadAgent, isBlobValue, portableAgentWorkflowInput, runAgent, agentWorkflow } from "vite-hub/agent"

export const stores = { createD1AgentInvocationStore, createLibsqlAgentInvocationStore, getAgent, isBlobValue, portableAgentWorkflowInput }
export const runtime = agentWorkflow("preflight-photo")

export async function run(name: string) {
  const agent = await loadAgent(name)
  return await runAgent(agent, { prompt: "Hi", context: { invoker: { id: "user-1", kind: "customer" } } })
}
