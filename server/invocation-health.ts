type InvocationStatus = 'completed' | 'failed' | 'pending' | 'running' | string

type InvocationSummaryInput = {
  createdAt: string
  startedAt?: string
  status: InvocationStatus
}

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
