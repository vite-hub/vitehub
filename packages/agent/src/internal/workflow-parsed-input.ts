import type { AgentRunInput } from "../types.ts"

const parsedInputs = new WeakMap<object, object>()

export function markParsedAgentWorkflowInput<CALL_OPTIONS, Agent extends object>(input: AgentRunInput<CALL_OPTIONS>, agent: Agent): void {
  parsedInputs.set(input, agent)
}

export function consumeParsedAgentWorkflowInput<CALL_OPTIONS, Agent extends object>(input: AgentRunInput<CALL_OPTIONS>, agent: Agent | undefined): boolean {
  const parsedAgent = parsedInputs.get(input)
  parsedInputs.delete(input)
  return agent !== undefined && parsedAgent === agent
}
