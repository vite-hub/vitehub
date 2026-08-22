import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invocationSummary, invocationTitle } from '../app/invocation-display.ts'

test('uses the Agent name as the invocation title', () => {
  assert.equal(invocationTitle({
    agentName: 'babysitter',
    createdAt: '2026-08-14T10:00:00Z',
    cursor: '1',
    id: 'run-1',
    status: 'running',
    traceId: 'trace-1',
    updatedAt: '2026-08-14T10:00:00Z',
  }), 'babysitter')
})

test('uses failure detail before generic invocation context', () => {
  assert.equal(invocationSummary({
    createdAt: '2026-08-14T10:00:00Z',
    cursor: '1',
    error: { message: 'Checks failed' },
    id: 'run-1',
    origin: 'schedule',
    status: 'failed',
    traceId: 'trace-1',
    updatedAt: '2026-08-14T10:00:00Z',
  }), 'Checks failed')
})
