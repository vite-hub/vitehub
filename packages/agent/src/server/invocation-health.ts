import type { AgentInvocationRecord, AgentInvocationStore, AgentInvocationSummary } from "../invocations.ts"

export async function failInterruptedAgentInvocations(
  store: AgentInvocationStore,
  options: {
    before?: number
    claimLeaseMs?: number
    limit?: number
    message?: string
    recover: (invocation: AgentInvocationSummary) => boolean | Promise<boolean>
  },
): Promise<number> {
  const before = options.before ?? Date.now()
  const claimLeaseMs = options.claimLeaseMs ?? 30_000
  const limit = options.limit ?? 100
  let cursor: string | undefined
  let failed = 0
  do {
    const records = await store.list({ cursor, limit, status: ["pending", "running"] })
    for (const invocation of records.invocations) {
      const startedAt = Date.parse(invocation.startedAt || invocation.createdAt)
      if (!Number.isFinite(startedAt) || startedAt >= before) continue
      if (!await options.recover(invocation)) continue
      const claimId = `recovery_${globalThis.crypto.randomUUID()}`
      if (!await store.claim(invocation.id, claimId, claimLeaseMs)) continue
      try {
        const updated = await store.update(invocation.id, {
          error: { message: options.message || "The host stopped before this Agent Invocation finished." },
          status: "failed",
          timestamp: new Date().toISOString(),
        }, claimId)
        if (updated?.status === "failed") failed += 1
      }
      finally {
        await store.release(invocation.id, claimId)
      }
    }
    cursor = records.cursor
  } while (cursor)
  return failed
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
