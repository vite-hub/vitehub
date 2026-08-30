type InvocationStatus = 'completed' | 'failed' | 'pending' | 'running' | string

type InvocationSummaryInput = {
  createdAt: string
  startedAt?: string
  status: InvocationStatus
}

type InvocationListResult = {
  cursor?: string
  invocations: readonly InvocationSummaryInput[]
}

type InvocationList = (options: { cursor?: string, limit: number, status?: readonly ('pending' | 'running')[] }) => Promise<InvocationListResult>

export function summarizeInvocationWorkload(invocations: readonly InvocationSummaryInput[], processStartedAt: number) {
  const counts = { active: 0, completed: 0, failed: 0, stale: 0, total: invocations.length }
  for (const invocation of invocations) {
    if (invocation.status === 'pending' || invocation.status === 'running') {
      const startedAt = Date.parse(invocation.startedAt || invocation.createdAt)
      if (Number.isFinite(startedAt) && startedAt < processStartedAt) counts.stale += 1
      else counts.active += 1
    }
    else if (invocation.status === 'completed') counts.completed += 1
    else if (invocation.status === 'failed') counts.failed += 1
  }
  return counts
}

export async function loadInvocationWorkload(list: InvocationList, processStartedAt: number) {
  const recent = await list({ limit: 100 })
  const active: InvocationSummaryInput[] = []
  let cursor: string | undefined

  do {
    const page = await list({ cursor, limit: 100, status: ['pending', 'running'] })
    active.push(...page.invocations)
    cursor = page.cursor
  } while (cursor)

  const recentCounts = summarizeInvocationWorkload(recent.invocations, processStartedAt)
  const activeCounts = summarizeInvocationWorkload(active, processStartedAt)
  const sampledActive = recentCounts.active + recentCounts.stale
  return {
    ...recentCounts,
    active: activeCounts.active,
    stale: activeCounts.stale,
    total: recentCounts.total - sampledActive + activeCounts.total,
  }
}
