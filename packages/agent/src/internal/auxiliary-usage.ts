import type { AgentInvocationContextStore, AgentUsageRecord } from "../types.ts"

const auxiliaryUsage = new WeakMap<AgentInvocationContextStore, AgentUsageRecord[]>()

export function recordAuxiliaryUsage(context: AgentInvocationContextStore, usage: AgentUsageRecord | undefined): void {
  if (!usage) return
  const calls = auxiliaryUsage.get(context) ?? []
  calls.push(usage)
  auxiliaryUsage.set(context, calls)
}

export function invocationUsageWithAuxiliaryCalls(context: AgentInvocationContextStore, primary: AgentUsageRecord | undefined): AgentUsageRecord | undefined {
  const auxiliary = auxiliaryUsage.get(context)
  if (!auxiliary?.length) return primary
  // An unreported primary call stays unknown rather than making auxiliary usage
  // look like a complete invocation total.
  const calls = [primary ?? {}, ...auxiliary]
  const usage: NonNullable<AgentUsageRecord["usage"]> = {}
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const values = calls.map(call => call.usage?.[key])
    if (values.every((value): value is number => value !== undefined && Number.isFinite(value))) {
      usage[key] = values.reduce((total, value) => total + value, 0)
    }
  }
  return { calls, usage, ...(primary?.cost ? { cost: primary.cost } : {}), ...(primary?.run ? { run: primary.run } : {}) }
}
