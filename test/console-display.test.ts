import assert from 'node:assert/strict'
import { test } from 'node:test'
import { annotationItems, invocationSummary, isToolObservation, statusLabel } from '../app/invocation-display.ts'

test('projects runtime statuses into Console groups', () => {
  assert.equal(statusLabel('pending'), 'Queued')
  assert.equal(statusLabel('completed'), 'Completed')
})

test('keeps GitHub context generic through annotations', () => {
  const [repository] = annotationItems({
    annotations: { 'github.repository': 'https://github.com/vite-hub/vitehub' },
    createdAt: '2026-08-14T10:00:00Z',
    cursor: '1',
    id: 'run-1',
    status: 'running',
    traceId: 'trace-1',
    updatedAt: '2026-08-14T10:00:00Z',
  })

  assert.deepEqual(repository, {
    href: 'https://github.com/vite-hub/vitehub',
    label: 'Github Repository',
    value: 'https://github.com/vite-hub/vitehub',
  })
})

test('recognizes tools from generic trace metadata', () => {
  assert.equal(isToolObservation({
    attributes: { 'tool.name': 'github.get_pull_request' },
    name: 'capability.step',
    sequence: 3,
    timestamp: '2026-08-14T10:00:00Z',
    type: 'capability',
  }), true)
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
