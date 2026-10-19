import type { AgentInvocationContextStore, AgentUsageRecord } from "../types.ts"

// Only these records carry a partial primary cost that may be recomputed.
export const auxiliaryUsageAggregates = new WeakSet<AgentUsageRecord>()

const auxiliaryUsage = new WeakMap<AgentInvocationContextStore, AgentUsageRecord[]>()
const driverUsage = new WeakMap<AgentInvocationContextStore, AgentUsageRecord[]>()

function append(calls: WeakMap<AgentInvocationContextStore, AgentUsageRecord[]>, context: AgentInvocationContextStore, usage: AgentUsageRecord | undefined): void {
  if (!usage) return
  const recorded = calls.get(context) ?? []
  recorded.push(usage)
  calls.set(context, recorded)
}

/** Records a model call that a Capability makes besides the Driver, such as a title. */
export function recordAuxiliaryUsage(context: AgentInvocationContextStore, usage: AgentUsageRecord | undefined): void {
  append(auxiliaryUsage, context, usage)
}

/**
 * Records one model call of a Driver that reports each call instead of one result usage, such as one Jev request
 * of `driver.ask`. The calls of such a Driver are its complete usage.
 */
export function recordDriverUsage(context: AgentInvocationContextStore, usage: AgentUsageRecord | undefined): void {
  append(driverUsage, context, usage)
}

export function invocationUsageWithAuxiliaryCalls(context: AgentInvocationContextStore, primary: AgentUsageRecord | undefined): AgentUsageRecord | undefined {
  const driver = driverUsage.get(context) ?? []
  const auxiliary = auxiliaryUsage.get(context) ?? []
  if (!driver.length && !auxiliary.length) return primary
  // An unreported primary call stays unknown rather than making auxiliary usage
  // look like a complete invocation total. A Driver that reports its calls has no other call.
  const calls = [...(primary ? [primary] : driver.length ? [] : [{}]), ...driver, ...auxiliary]
  const usage: NonNullable<AgentUsageRecord["usage"]> = {}
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const values = calls.map(call => call.usage?.[key])
    if (values.every((value): value is number => value !== undefined && Number.isFinite(value))) {
      usage[key] = values.reduce((total, value) => total + value, 0)
    }
  }
  // Without a primary record, calls that all name one model name the Invocation's model too.
  const models = new Set(calls.map(call => call.model))
  const model = !primary && models.size === 1 ? calls[0]?.model : undefined
  const aggregate = { calls, ...(model ? { model } : {}), usage, ...(primary?.cost ? { cost: primary.cost } : {}), ...(primary?.run ? { run: primary.run } : {}) }
  auxiliaryUsageAggregates.add(aggregate)
  return aggregate
}
