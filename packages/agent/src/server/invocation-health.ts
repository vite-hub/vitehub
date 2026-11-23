import type {
  AgentInvocationRecord,
  AgentInvocations,
  AgentInvocationStore,
  AgentInvocationSummary,
} from "../invocations.ts"
import { getInstanceId } from "@vite-hub/runtime"
import { emitRunFailed } from "@vite-hub/runtime/internal/run-failed"

import { invocationDiagnostics } from "../invocation-diagnostics.ts"

/** A claim id that starts with `getInstanceId()`, so the journal shows which instance holds an Invocation. */
export function createInvocationClaimId(prefix = ""): string {
  return `${getInstanceId().slice(0, 200)}/${prefix}${globalThis.crypto.randomUUID()}`
}

export async function failInterruptedAgentInvocations(
  store: AgentInvocationStore,
  options: {
    before?: number
    claimLeaseMs?: number
    limit?: number
    message?: string
    agentName?: string
    recoveryTimeoutMs?: number
    /** Waits `recoveryTimeoutMs` and retries Invocations that a claim blocked. The periodic sweep turns it off. */
    waitForBlocked?: boolean
    canRecover?: () => boolean
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
  const seenCursors = new Set<string>()
  let paginationError: Error | undefined
  const canRecover = options.canRecover ?? (() => true)
  const fail = async (invocation: AgentInvocationSummary, replaceClaimToken?: string): Promise<boolean> => {
    if (!canRecover()) return false
    const claimId = createInvocationClaimId("recovery_")
    if (!await store.claim(invocation.id, claimId, claimLeaseMs,
      replaceClaimToken === undefined ? undefined : { replaceClaimToken })) return false
    const message = options.message || "The host stopped before this Agent Invocation finished."
    const timestamp = new Date().toISOString()
    let updated: Awaited<ReturnType<AgentInvocationStore["update"]>>
    try {
      if (!canRecover()) return false
      const current = await store.getSummary(invocation.id)
      if (!canRecover() || (current?.status !== "pending" && current?.status !== "running")) return false
      updated = await store.update(invocation.id, { error: { message }, status: "failed", timestamp }, claimId)
    }
    finally {
      await store.release(invocation.id, claimId)
    }
    if (updated?.status !== "failed") return false
    await emitRunFailed({ event: "invocation.failed", agent: invocation.agentName ?? null, invocationId: invocation.id, error: { message }, failedAt: timestamp })
    return true
  }
  do {
    if (!canRecover()) return failed
    const records = await store.list({ cursor, limit, status: ["pending", "running"], ...(options.agentName ? { agentName: options.agentName } : {}) })
    if (records.cursor && seenCursors.has(records.cursor)) {
      paginationError = new Error("[vitehub] Agent Invocation listing returned a repeated pagination cursor.")
      break
    }
    if (records.cursor) seenCursors.add(records.cursor)
    for (const invocation of records.invocations) {
      if (!canRecover()) return failed
      const startedAt = Date.parse(invocation.startedAt || invocation.createdAt)
      if (!Number.isFinite(startedAt) || startedAt >= before) continue
      if (!await options.recover(invocation) || !canRecover()) continue
      const blockedClaimToken = options.waitForBlocked === false ? undefined : await store.getClaimToken(invocation.id)
      if (await fail(invocation)) failed += 1
      else if (blockedClaimToken !== undefined && options.waitForBlocked !== false) blocked.push({ ...invocation, blockedClaimToken })
    }
    cursor = records.cursor
  } while (cursor)
  if (blocked.length > 0) {
    await new Promise(resolve => setTimeout(resolve, recoveryTimeoutMs))
    for (const invocation of blocked) {
      if (!canRecover()) return failed
      const current = await store.get(invocation.id)
      if (current && (current.status === "pending" || current.status === "running")
        && await options.recover(current) && await fail(current, invocation.blockedClaimToken)) failed += 1
    }
  }
  if (paginationError) throw paginationError
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
  options: { agentName?: string } = {},
): Promise<{ active: number, completed: number, failed: number, stale: number, total: number }> {
  const recent = await invocations.list({ limit: 100, ...(options.agentName ? { agentName: options.agentName } : {}) })
  const records = new Map(recent.invocations.map(invocation => [invocation.id, invocation]))
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  do {
    const active = await invocations.list({ cursor, limit: 100, status: ["pending", "running"], ...(options.agentName ? { agentName: options.agentName } : {}) })
    for (const invocation of active.invocations) records.set(invocation.id, invocation)
    if (active.cursor && seenCursors.has(active.cursor)) {
      throw invocationDiagnostics.AGENT_INVOCATION_CURSOR_REPEATED()
    }
    if (active.cursor) seenCursors.add(active.cursor)
    cursor = active.cursor
  } while (cursor)
  return summarizeAgentInvocationWorkload([...records.values()], processStartedAt)
}
