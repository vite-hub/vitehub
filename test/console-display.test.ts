import assert from 'node:assert/strict'
import { test } from 'node:test'
import { invocationContext, invocationProject, invocationSummary, invocationTitle } from '../app/invocation-display.ts'

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

test('uses GitHub metadata for session titles and context', () => {
  const invocation = {
    agentName: 'babysitter',
    annotations: {
      'github.pullRequest': 1015,
      'github.repository': 'vite-hub/vitehub',
      'github.title': 'feat(ui): add the invocation console',
    },
    createdAt: '2026-08-14T10:00:00Z',
    cursor: '1',
    id: 'run-1',
    status: 'running' as const,
    traceId: 'trace-1',
    updatedAt: '2026-08-14T10:00:00Z',
  }

  assert.equal(invocationTitle(invocation), 'feat(ui): add the invocation console')
  assert.equal(invocationContext(invocation), 'vite-hub/vitehub · PR #1015')
  assert.equal(invocationProject(invocation), 'vitehub')
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
