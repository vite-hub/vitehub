import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeInvocationWorkload } from '../server/invocation-health.ts'

test('separates stale invocation records from current active work', () => {
  assert.deepEqual(summarizeInvocationWorkload([
    { createdAt: '2026-08-30T09:00:00Z', status: 'running' },
    { createdAt: '2026-08-30T10:01:00Z', status: 'pending' },
    { createdAt: '2026-08-30T09:00:00Z', status: 'completed' },
    { createdAt: '2026-08-30T09:00:00Z', status: 'failed' },
  ], Date.parse('2026-08-30T10:00:00Z')), {
    active: 1,
    completed: 1,
    failed: 1,
    stale: 1,
    total: 4,
  })
})

test('keeps malformed active timestamps visible instead of declaring them stale', () => {
  assert.deepEqual(summarizeInvocationWorkload([
    { createdAt: 'unknown', status: 'running' },
  ], Date.parse('2026-08-30T10:00:00Z')), {
    active: 1,
    completed: 0,
    failed: 0,
    stale: 0,
    total: 1,
  })
})
