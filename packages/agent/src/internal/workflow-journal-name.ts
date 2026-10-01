import type { AgentRuntimeContext } from "../types.ts"

const workflowJournalName: unique symbol = Symbol.for("vitehub.agent.workflowJournalName")

type WorkflowJournalContext = { [workflowJournalName]?: { agent: unknown, name: string } }

export function setWorkflowJournalName(context: AgentRuntimeContext, agent: unknown, name: string): void {
  Object.defineProperty(context, workflowJournalName, { enumerable: true, value: { agent, name } })
}

export function readWorkflowJournalName(context: Pick<AgentRuntimeContext, "agentIdentity">, agent: unknown): string | undefined {
  // SAFETY: Only setWorkflowJournalName writes this private context key.
  const journal = (context as WorkflowJournalContext)[workflowJournalName]
  return journal && journal.agent === agent ? journal.name : undefined
}
