export const agentProviderCleanupTask: unique symbol = Symbol("vitehub.agent.providerCleanupTask")

export async function settleAgentProviderCleanups(cleanups: readonly Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(cleanups)
  const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "[vitehub] Provider Agent cleanup failed.")
}
