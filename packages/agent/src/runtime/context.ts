import type { AgentRuntimeConfig, AgentRuntimeContext } from "../types.ts"

export function createAgentRuntimeContext<TRuntimeConfig extends AgentRuntimeConfig>(
  input: Omit<AgentRuntimeContext<TRuntimeConfig>, "memo"> & { memo?: AgentRuntimeContext<TRuntimeConfig>["memo"] },
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
