import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import {
  logOperationalError,
  reportOperationalDiagnostic,
} from '../server/babysitter.operations.ts'

test('records nested and aggregate failures as one structured line', () => {
  const checkout = new Error('Checkout restore failed')
  const telemetry = Object.assign(new Error('Console unavailable', { cause: checkout }), { code: 'ECONNREFUSED' })
  const error = new AggregateError([telemetry], 'Invocation cleanup failed')
  const output = mock.method(console, 'error', () => {})

  try {
    logOperationalError('babysitter.owner.failed', error, { runId: 'run-1007' })
    assert.equal(output.mock.callCount(), 1)
    const line = String(output.mock.calls[0]!.arguments[0])
    assert.match(line, /^\[babysitter\] /)
    const record = JSON.parse(line.slice('[babysitter] '.length))
    assert.equal(record.event, 'babysitter.owner.failed')
    assert.equal(record.runId, 'run-1007')
    assert.equal(record.error.message, 'Invocation cleanup failed')
    assert.equal(record.error.errors[0].code, 'ECONNREFUSED')
    assert.equal(record.error.errors[0].cause.message, 'Checkout restore failed')
  }
  finally {
    output.mock.restore()
  }
})

test('writes ViteHub diagnostics through the Babysitter operations lane', () => {
  const output = mock.method(console, 'warn', () => {})
  try {
    reportOperationalDiagnostic({
      attributes: { run_id: 'run-1007' },
      component: '@vite-hub/agent',
      level: 'warn',
      name: 'agent.resource.peak',
      timestamp: '2026-08-22T09:00:00.000Z',
    })
    const line = String(output.mock.calls[0]!.arguments[0])
    const record = JSON.parse(line.slice('[babysitter] '.length))
    assert.equal(record.event, 'agent.resource.peak')
    assert.equal(record.component, '@vite-hub/agent')
    assert.deepEqual(record.attributes, { run_id: 'run-1007' })
  }
  finally {
    output.mock.restore()
  }
})
