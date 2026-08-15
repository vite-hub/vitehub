import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryAgentInvocationStore } from 'vite-hub/agent/server'
import { mirrorAgentInvocationStore } from '../server/invocation-mirror.ts'

test('mirrors successful snapshots without making local writes depend on Console', async () => {
  const snapshots: string[] = []
  let release!: () => void
  const sending = new Promise<void>(resolve => { release = resolve })
  const store = mirrorAgentInvocationStore(createMemoryAgentInvocationStore(), async invocation => {
    snapshots.push(invocation.status)
    await sending
  })
  const createdAt = new Date().toISOString()

  const created = await store.create({
    createdAt,
    id: 'invocation-1',
    observations: [],
    status: 'pending',
    traceId: 'trace-1',
    updatedAt: createdAt,
  })
  const updated = await store.update('invocation-1', { status: 'running', timestamp: createdAt })

  assert.equal(created.record.status, 'pending')
  assert.equal(updated?.status, 'running')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(snapshots, ['pending'])
  release()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(snapshots, ['pending', 'running'])
})
