import type { AgentRuntimeConfig, AgentRuntimeContext, AgentRuntimeContextInput } from "../types.ts"

export function createAgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig>(
  input: AgentRuntimeContextInput<TRuntimeConfig>,
): AgentRuntimeContext<TRuntimeConfig> {
  const values = new Map<string, unknown>()
  const memo: AgentRuntimeContext["memo"] = input.memo || ((key, create) => {
    if (!values.has(key)) {
      values.set(key, create())
    }
    return values.get(key) as never
  })

  return {
    ...input,
    memo,
  }
}

/** Keep a host context that has a memo cache. Give a caller context without one a fresh cache. */
export function withAgentRuntimeMemo<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentRuntimeContextInput<TRuntimeConfig>,
): AgentRuntimeContext<TRuntimeConfig> {
  return hasAgentRuntimeMemo(context) ? context : createAgentRuntimeContext(context)
}

function hasAgentRuntimeMemo<TRuntimeConfig extends AgentRuntimeConfig>(
  context: AgentRuntimeContextInput<TRuntimeConfig>,
): context is AgentRuntimeContext<TRuntimeConfig> {
  return typeof context.memo === "function"
}
