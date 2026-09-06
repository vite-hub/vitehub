import type {
  AgentInvocationRecord,
  AgentInvocations,
  AgentInvocationStore,
  AgentInvocationSummary,
} from "../invocations.ts"

export async function failInterruptedAgentInvocations(
  store: AgentInvocationStore,
  options: {
    before?: number
    claimLeaseMs?: number
    limit?: number
    message?: string
    recoveryTimeoutMs?: number
    recover: (invocation: AgentInvocationSummary) => boolean | Promise<boolean>
  },
): Promise<number> {
  const before = options.before ?? Date.now()
  const claimLeaseMs = options.claimLeaseMs ?? 30_000
  const recoveryTimeoutMs = options.recoveryTimeoutMs ?? claimLeaseMs
  const limit = options.limit ?? 100
  let cursor: string | undefined
  let failed = 0
  const blocked: (AgentInvocationSummary & { blockedClaimToken: string })[] = []
  const fail = async (invocation: AgentInvocationSummary, replaceClaimToken?: string): Promise<boolean> => {
    const claimId = `recovery_${globalThis.crypto.randomUUID()}`
    if (!await store.claim(invocation.id, claimId, claimLeaseMs,
      replaceClaimToken === undefined ? undefined : { replaceClaimToken })) return false
    try {
      const updated = await store.update(invocation.id, {
        error: { message: options.message || "The host stopped before this Agent Invocation finished." },
        status: "failed",
        timestamp: new Date().toISOString(),
      }, claimId)
      return updated?.status === "failed"
    }
    finally {
      await store.release(invocation.id, claimId)
    }
  }
  do {
    const records = await store.list({ cursor, limit, status: ["pending", "running"] })
    for (const invocation of records.invocations) {
      const startedAt = Date.parse(invocation.startedAt || invocation.createdAt)
      if (!Number.isFinite(startedAt) || startedAt >= before) continue
      if (!await options.recover(invocation)) continue
      const blockedClaimToken = await store.getClaimToken(invocation.id)
      if (await fail(invocation)) failed += 1
      else if (blockedClaimToken !== undefined) blocked.push({ ...invocation, blockedClaimToken })
    }
    cursor = records.cursor
  } while (cursor)
  if (blocked.length > 0) {
    await new Promise(resolve => setTimeout(resolve, recoveryTimeoutMs))
    for (const invocation of blocked) {
      const current = await store.get(invocation.id)
      if (current && (current.status === "pending" || current.status === "running")
        && await options.recover(current) && await fail(current, invocation.blockedClaimToken)) failed += 1
    }
  }
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

export async function readAgentInvocationWorkload(
  invocations: Pick<AgentInvocations, "list">,
  processStartedAt: number,
): Promise<{ active: number, completed: number, failed: number, stale: number, total: number }> {
  const recent = await invocations.list({ limit: 100 })
  const records = new Map(recent.invocations.map(invocation => [invocation.id, invocation]))
  let cursor: string | undefined
  do {
    const active = await invocations.list({ cursor, limit: 100, status: ["pending", "running"] })
    for (const invocation of active.invocations) records.set(invocation.id, invocation)
    cursor = active.cursor
  } while (cursor)
  return summarizeAgentInvocationWorkload([...records.values()], processStartedAt)
}
