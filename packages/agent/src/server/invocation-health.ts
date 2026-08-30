import type { AgentInvocationRecord, AgentInvocationStore } from "../invocations.ts"

export async function failInterruptedAgentInvocations(
  store: AgentInvocationStore,
  options: { before?: number, limit?: number, message?: string } = {},
): Promise<number> {
  const records = await store.list({ limit: options.limit ?? 100, status: ["pending", "running"] })
  const before = options.before ?? Date.now()
  const interrupted = records.invocations.filter((invocation) => {
    const startedAt = Date.parse(invocation.startedAt || invocation.createdAt)
    return Number.isFinite(startedAt) && startedAt < before
  })
  await Promise.all(interrupted.map(invocation => store.update(invocation.id, {
    error: { message: options.message || "The host stopped before this Agent Invocation finished." },
    status: "failed",
    timestamp: new Date().toISOString(),
  })))
  return interrupted.length
}

export function summarizeAgentInvocationWorkload(
  recent: readonly Pick<AgentInvocationRecord, "createdAt" | "startedAt" | "status">[],
  processStartedAt: number,
): { active: number, completed: number, failed: number, stale: number, total: number } {
  const counts = { active: 0, completed: 0, failed: 0, stale: 0, total: recent.length }
  for (const invocation of recent) {
    if (invocation.status === "pending" || invocation.status === "running") {
      const startedAt = Date.parse(invocation.startedAt || invocation.createdAt)
      if (Number.isFinite(startedAt) && startedAt < processStartedAt) counts.stale += 1
      else counts.active += 1
    }
    else if (invocation.status === "completed") counts.completed += 1
    else if (invocation.status === "failed") counts.failed += 1
  }
  return counts
}
