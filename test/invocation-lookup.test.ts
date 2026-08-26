import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decodeInvocationRouteId, resolveBabysitterInvocation } from '../server/invocation-lookup.ts'

test('decodes the detail route exactly once', () => {
  assert.equal(
    decodeInvocationRouteId('srun_static_server%252Fbabysitter_2026-08-24T20%3A20%3A00.000Z'),
    'srun_static_server%2Fbabysitter_2026-08-24T20:20:00.000Z',
  )
})

test('resolves legacy session links by their raw run id', async () => {
  const calls: string[] = []
  const resolved = { id: 'sha256_session' }
  const journal = {
    async get(id: string) {
      calls.push(`get:${id}`)
      return undefined as { id: string } | undefined
    },
    async getByRunId(runId: string, agentName?: string) {
      calls.push(`getByRunId:${agentName}:${runId}`)
      return resolved
    },
  }

  const result = await resolveBabysitterInvocation(journal, 'srun_static_server%2Fbabysitter_2026-08-24T20:20:00.000Z:vite-hub/vitehub:pr-1042:a9567b5b4e15aba7')

  assert.equal(result, resolved)
  assert.deepEqual(calls, [
    'get:srun_static_server%2Fbabysitter_2026-08-24T20:20:00.000Z:vite-hub/vitehub:pr-1042:a9567b5b4e15aba7',
    'getByRunId:babysitter:srun_static_server%2Fbabysitter_2026-08-24T20:20:00.000Z:vite-hub/vitehub:pr-1042:a9567b5b4e15aba7',
  ])
})
