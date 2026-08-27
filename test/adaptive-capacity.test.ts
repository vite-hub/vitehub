import assert from 'node:assert/strict'
import test from 'node:test'
import { createProcessAgentCapacity } from '@vite-hub/agent/runtime/process'
import {
  createAgentInspectionMetadata,
  defineAgent,
  runAgentInline,
  type AgentRuntimeContext,
} from 'vite-hub/agent'

function runtime(): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: 'unknown',
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for adaptive capacity state.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('rejects invalid process capacity policy', () => {
  assert.throws(
    () => createProcessAgentCapacity({ concurrency: 2, cpu: { pausePressure: 0.25, resumePressure: 0.5 } }),
    /cpu\.resumePressure/,
  )
  assert.throws(
    () => createProcessAgentCapacity({ concurrency: 2, memory: { reserveBytes: -1 } }),
    /memory\.reserveBytes/,
  )
})

test('shares adaptive capacity and queues across separate agent definitions', async () => {
  const gates = [deferred(), deferred(), deferred()]
  const starts: string[] = []
  const capacity = createProcessAgentCapacity({
    concurrency: 3,
    fallbackConcurrency: 0,
    intervalMs: 100,
    queue: { maxPending: 10 },
    rampUp: 2,
    sample: () => ({ concurrency: 2, reason: 'test capacity' }),
  })
  const create = (name: string) => defineAgent({
    driver: {
      capacity,
      async run({ input }) {
        const index = Number(input.prompt)
        starts.push(`${name}:${index}`)
        await gates[index]!.promise
        return name
      },
    },
    runtime: false,
  })
  const firstAgent = create('first')
  const secondAgent = create('second')

  const runs = [
    runAgentInline(firstAgent, runtime(), { prompt: '0' }),
    runAgentInline(secondAgent, runtime(), { prompt: '1' }),
    runAgentInline(firstAgent, runtime(), { prompt: '2' }),
  ]
  await waitFor(() => starts.length === 2)
  const queued = createAgentInspectionMetadata(secondAgent).config?.driver.capacity
  assert.equal(queued?.active, 2)
  assert.equal(queued?.concurrency, 3)
  assert.equal(queued?.effectiveConcurrency, 2)
  assert.equal(queued?.pending, 1)
  assert.equal(queued?.reason, 'test capacity')
  assert.equal(typeof queued?.lastSampleAt, 'number')

  gates[0]!.resolve()
  await waitFor(() => starts.length === 3)
  gates[1]!.resolve()
  gates[2]!.resolve()
  await Promise.all(runs)
  assert.equal(createAgentInspectionMetadata(firstAgent).config?.driver.capacity?.active, 0)
})

test('keeps work queued at zero capacity and resumes after a later sample', async () => {
  let available = false
  const started = deferred()
  const finish = deferred()
  const capacity = createProcessAgentCapacity({
    concurrency: 6,
    fallbackConcurrency: 0,
    intervalMs: 100,
    queue: { maxPending: 10 },
    rampUp: 1,
    sample: () => ({ concurrency: available ? 6 : 0, reason: available ? 'available' : 'pressure' }),
  })
  const agent = defineAgent({
    driver: {
      capacity,
      async run() {
        started.resolve()
        await finish.promise
        return 'done'
      },
    },
    runtime: false,
  })

  const run = runAgentInline(agent, runtime(), {})
  await waitFor(() => createAgentInspectionMetadata(agent).config?.driver.capacity?.pending === 1)
  assert.equal(createAgentInspectionMetadata(agent).config?.driver.capacity?.effectiveConcurrency, 0)
  available = true
  await started.promise
  const status = createAgentInspectionMetadata(agent).config?.driver.capacity
  assert.equal(status?.effectiveConcurrency, 1)
  assert.equal(status?.active, 1)
  finish.resolve()
  await assert.doesNotReject(run)
})

test('falls back conservatively when sampling fails', async () => {
  const finish = deferred()
  let starts = 0
  const capacity = createProcessAgentCapacity({
    concurrency: 6,
    fallbackConcurrency: 1,
    intervalMs: 100,
    queue: { maxPending: 10 },
    sample: () => {
      throw new Error('unavailable')
    },
  })
  const agent = defineAgent({
    driver: {
      capacity,
      async run() {
        starts++
        await finish.promise
        return 'done'
      },
    },
    runtime: false,
  })

  const first = runAgentInline(agent, runtime(), {})
  const second = runAgentInline(agent, runtime(), {})
  await waitFor(() => starts === 1)
  const status = createAgentInspectionMetadata(agent).config?.driver.capacity
  assert.equal(status?.effectiveConcurrency, 1)
  assert.equal(status?.pending, 1)
  assert.match(status?.reason || '', /^sample-error: unavailable/)
  finish.resolve()
  await Promise.all([first, second])
})

test('removes an aborted invocation from the adaptive queue', async () => {
  const capacity = createProcessAgentCapacity({
    concurrency: 2,
    fallbackConcurrency: 0,
    intervalMs: 100,
    queue: { maxPending: 10 },
    sample: () => ({ concurrency: 0, reason: 'pressure' }),
  })
  const agent = defineAgent({
    driver: { capacity, run: () => 'unreachable' },
    runtime: false,
  })
  const abort = new AbortController()
  const run = runAgentInline(agent, runtime(), { abortSignal: abort.signal })
  await waitFor(() => createAgentInspectionMetadata(agent).config?.driver.capacity?.pending === 1)
  abort.abort(new Error('cancelled'))
  await assert.rejects(run, /cancelled/)
  assert.equal(createAgentInspectionMetadata(agent).config?.driver.capacity?.pending, 0)
})
