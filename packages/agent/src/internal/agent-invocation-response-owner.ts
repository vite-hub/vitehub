import { agentInvocationControlId, withAgentInvocationControlId } from "./agent-invocation-control.ts"

const responseOwner = Symbol("vitehub.agentInvocationResponseOwner")

type AgentInvocationResponseOwnerContext = {
  [responseOwner]?: true
  run?: { runId?: string }
}

export function withAgentInvocationResponseOwner<TContext extends object>(context: TContext, id: string): TContext {
  return { ...withAgentInvocationControlId(context, id), [responseOwner]: true }
}

export function ownedAgentInvocationControlId(context: AgentInvocationResponseOwnerContext): string | undefined {
  return context[responseOwner] ? agentInvocationControlId(context) : undefined
}
