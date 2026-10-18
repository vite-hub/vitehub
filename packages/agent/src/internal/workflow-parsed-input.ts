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

/** Move the one-use parsing exemption when runtime cancellation wraps an input. */
export function transferParsedAgentWorkflowInput<CALL_OPTIONS>(source: AgentRunInput<CALL_OPTIONS>, target: AgentRunInput<CALL_OPTIONS>): void {
  const agent = parsedInputs.get(source)
  parsedInputs.delete(source)
  if (agent) parsedInputs.set(target, agent)
}
