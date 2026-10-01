import type { AgentRunInput } from "../types.ts"

// Live signals stay local. Trusted runtimes restore only their caller provenance.
const callerAbortSignals = new WeakMap<object, boolean | undefined>()

export function markAgentInvocationCallerAbortSignal(input: AgentRunInput, supplied: boolean | undefined): void {
  callerAbortSignals.set(input, supplied)
}

/** Keep trusted provenance across a local clone that retains the same live signal. */
export function copyAgentInvocationCallerAbortSignal<TInput extends AgentRunInput>(source: AgentRunInput, target: TInput): TInput {
  if (source.abortSignal === target.abortSignal && callerAbortSignals.has(source)) {
    callerAbortSignals.set(target, callerAbortSignals.get(source))
  }
  return target
}

export function agentInvocationCallerAbortSignal(input: AgentRunInput): boolean | undefined {
  return callerAbortSignals.has(input) ? callerAbortSignals.get(input) : input.abortSignal !== undefined
}
