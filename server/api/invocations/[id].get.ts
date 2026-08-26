import { createError, defineEventHandler, getRouterParam } from 'h3'
import { invocations } from '../../invocations.ts'
import { decodeInvocationRouteId, resolveBabysitterInvocation } from '../../invocation-lookup.ts'
import { useSessionSnapshotStore } from '../../session-snapshots.ts'
import { sessionTimelineObservations } from '../../session-timeline.ts'

export default defineEventHandler(async (event) => {
  const id = decodeInvocationRouteId(getRouterParam(event, 'id') || '')
  const invocation = await resolveBabysitterInvocation(invocations, id)
  if (!invocation) throw createError({ status: 404, statusText: 'Invocation not found' })
  const { observations, ...summary } = invocation
  const snapshot = useSessionSnapshotStore().getForInvocation(invocation)
  return {
    invocation: { ...summary, ...(snapshot?.agent ? { configuration: snapshot.agent } : {}) },
    observations: sessionTimelineObservations(snapshot?.events ?? [], observations),
  }
})
