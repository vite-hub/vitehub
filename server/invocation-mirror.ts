import type { AgentInvocationRecord, AgentInvocationStore } from 'vite-hub/agent/server'

export function mirrorAgentInvocationStore(
  store: AgentInvocationStore,
  send?: (invocation: AgentInvocationRecord) => Promise<void>,
): AgentInvocationStore {
  if (!send) return store

  // ponytail: Full snapshots coalesce in memory; use an outbox when export must survive process restarts.
  const pending = new Map<string, AgentInvocationRecord>()
  const sending = new Set<string>()
  const flush = async (id: string) => {
    while (true) {
      const invocation = pending.get(id)
      if (!invocation) {
        sending.delete(id)
        return
      }
      pending.delete(id)
      try {
        await send(invocation)
      }
      catch {
        console.error('ViteHub Console invocation export failed.')
      }
    }
  }
  const mirror = (invocation: AgentInvocationRecord) => {
    pending.set(invocation.id, invocation)
    if (sending.has(invocation.id)) return
    sending.add(invocation.id)
    void flush(invocation.id)
  }

  return {
    ...store,
    async create(input) {
      const result = await store.create(input)
      mirror(result.record)
      return result
    },
    async update(id, input, claimId) {
      const invocation = await store.update(id, input, claimId)
      if (invocation) mirror(invocation)
      return invocation
    },
  }
}
