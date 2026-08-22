import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isRunningStale, syncFreshness } from '../app/freshness.ts'

const updatedAt = '2026-08-22T14:00:00.000Z'
const updatedAtMs = Date.parse(updatedAt)

test('marks a running invocation stale at thirty seconds', () => {
  assert.equal(isRunningStale('running', updatedAt, updatedAtMs + 29_999), false)
  assert.equal(isRunningStale('running', updatedAt, updatedAtMs + 30_000), true)
  assert.equal(isRunningStale('completed', updatedAt, updatedAtMs + 60_000), false)
  assert.equal(isRunningStale('running', 'invalid', updatedAtMs + 60_000), false)
})

test('keeps transport freshness separate from invocation status', () => {
  assert.deepEqual(syncFreshness(undefined, updatedAtMs), { label: 'Connecting', stale: false })
  assert.deepEqual(syncFreshness(updatedAtMs, updatedAtMs + 29_999), { label: 'Updated now', stale: false })
  assert.deepEqual(syncFreshness(updatedAtMs, updatedAtMs + 30_000), { label: 'Stale · 30s', stale: true })
})
