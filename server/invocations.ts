import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'
import { defineAgentInvocations, failInterruptedAgentInvocations } from 'vite-hub/agent/server'

const store = createLibsqlAgentInvocationStore({ url: 'file:.vitehub/invocations.sqlite' })

// ponytail: Babysitter is single-host; use leases before sharing this database across owners.
try {
  await failInterruptedAgentInvocations(store, {
    message: 'The Babysitter host stopped before this invocation finished.',
  })
}
catch (error) {
  console.error(new Error('Could not recover interrupted Agent Invocations.', { cause: error }))
}

export const invocations = defineAgentInvocations({
  content: 'content',
  store,
})
