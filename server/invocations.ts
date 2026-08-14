import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
import { defineAgentInvocations } from 'vite-hub/agent/server'

const store = createLibsqlAgentInvocationStore({ url: 'file:.vitehub/invocations.sqlite' })

// ponytail: Babysitter is single-host; use leases before sharing this database across owners.
try {
  const interrupted = await store.list({ limit: 100, status: ['pending', 'running'] })
  await Promise.all(interrupted.invocations.map(invocation => store.update(invocation.id, {
    error: { message: 'The Babysitter host stopped before this invocation finished.' },
    status: 'failed',
    timestamp: new Date().toISOString(),
  })))
}
catch (error) {
  console.error(new Error('Could not recover interrupted Agent Invocations.', { cause: error }))
}

export const invocations = defineAgentInvocations({
  store,
})
