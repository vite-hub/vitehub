import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createLibsqlAgentInvocationStore } from 'vite-hub/agent/invocations/sqlite'

function invocation(id: string, updatedAt = new Date().toISOString()) {
  return {
    createdAt: updatedAt,
    id,
    observations: [],
    status: 'completed' as const,
    traceId: `trace-${id}`,
    updatedAt,
  }
}

test('bounds the SQLite invocation journal by count and age', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'babysitter-invocations-'))
  context.after(() => rm(directory, { force: true, recursive: true }))

  const store = createLibsqlAgentInvocationStore({
    maxAgeMs: 1_000,
    maxRecords: 2,
    url: `file:${join(directory, 'invocations.sqlite')}`,
  })

  await store.create(invocation('expired', new Date(Date.now() - 2_000).toISOString()))
  await store.create(invocation('first'))
  await store.create(invocation('second'))
  await store.create(invocation('third'))

  assert.deepEqual((await store.list({ limit: 10 })).invocations.map(record => record.id), ['third', 'second'])
  assert.equal(await store.get('expired'), undefined)
  assert.equal(await store.get('first'), undefined)
})
