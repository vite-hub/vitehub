import { createD1AgentInvocationStore } from "vite-hub/agent/invocations/d1"
import { createLibsqlAgentInvocationStore } from "vite-hub/agent/invocations/sqlite"
import { getAgent, getAgentFromRegistry, isBlobValue, portableAgentWorkflowInput, runAgent, workflow } from "vite-hub/agent"

export const stores = { createD1AgentInvocationStore, createLibsqlAgentInvocationStore, getAgent, isBlobValue, portableAgentWorkflowInput }
export const runtime = workflow("preflight-photo")

export async function run(name: string) {
  const agent = await getAgentFromRegistry(name)
  return await runAgent(agent, { prompt: "Hi", context: { actor: { id: "user-1", kind: "customer" } } })
}
