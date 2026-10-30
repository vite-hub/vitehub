import { readDiscoveredAgentName } from "./discovered-agent-name.ts"
import { readWorkflowJournalName } from "./workflow-journal-name.ts"
import type { AgentRuntimeContext } from "../types.ts"

// Preparation and execution must use the same name for the Console journal.
export function agentInvocationName(agent: { name?: string }, context: Pick<AgentRuntimeContext, "agentIdentity">): string | undefined {
  return agent.name || context.agentIdentity?.name || readWorkflowJournalName(context, agent) || readDiscoveredAgentName(agent)
}
