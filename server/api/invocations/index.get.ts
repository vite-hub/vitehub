import { defineEventHandler, getQuery } from 'h3'
import { invocations } from '../../invocations.ts'
import { useSessionSnapshotStore } from '../../session-snapshots.ts'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined
  const search = typeof query.search === 'string' ? query.search : undefined
  const result = await invocations.list({ cursor, limit: 50, search })
  const snapshots = useSessionSnapshotStore()
  return {
    ...result,
    invocations: result.invocations.map((invocation) => {
      const repository = invocation.annotations?.['github.repository']
      const revision = invocation.annotations?.['github.head']
      const pullRequest = invocation.annotations?.['github.pullRequest']
      if (typeof repository !== 'string' || typeof revision !== 'string' || typeof pullRequest !== 'number') return invocation
      const provider = snapshots.getPrepared(repository, revision, pullRequest)?.agent?.driver?.model?.provider
      if (!provider) return invocation
      return { ...invocation, annotations: { ...invocation.annotations, 'agent.model.provider': provider } }
    }),
  }
})
