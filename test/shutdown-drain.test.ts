import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createBabysitterReconciler,
  listenForBabysitterDrainSignal,
} from '../server/babysitter.reconciler.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('drain quiesces reconciliation before awaiting active and capacity-queued owners', async () => {
  const reconciliation = deferred()
  const activeOwner = deferred()
  const capacityQueuedOwner = deferred()
  const events: string[] = []
  let drained = false

  const reconciler = createBabysitterReconciler({
    onDrained: () => events.push('drained'),
    onError: error => assert.fail(error instanceof Error ? error : String(error)),
    onQuiesce: () => events.push('quiesced'),
    reconcile: async () => {
      events.push('reconciling')
      await reconciliation.promise
    },
    repairIntervalMs: 60_000,
    waitForOwners: async () => {
      events.push('waiting-for-owners')
      await Promise.all([activeOwner.promise, capacityQueuedOwner.promise])
    },
  })

  assert.equal(reconciler.status(), 'accepting')
  reconciler.wake('startup')
  await Promise.resolve()
  const draining = reconciler.drain().then(() => { drained = true })
  reconciler.wake('must-be-ignored')

  assert.deepEqual(events, ['reconciling', 'quiesced'])
  assert.equal(reconciler.status(), 'draining')
  reconciliation.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['reconciling', 'quiesced', 'waiting-for-owners'])

  activeOwner.resolve()
  await Promise.resolve()
  assert.equal(drained, false)
  capacityQueuedOwner.resolve()
  await draining

  assert.equal(drained, true)
  assert.equal(reconciler.status(), 'drained')
  assert.deepEqual(events, ['reconciling', 'quiesced', 'waiting-for-owners', 'drained'])
})

test('drain cancels a queued reconciliation wake and is idempotent', async () => {
  let reconciliations = 0
  let quiesces = 0
  let waits = 0
  const reconciler = createBabysitterReconciler({
    onDrained: () => {},
    onError: error => assert.fail(error instanceof Error ? error : String(error)),
    onQuiesce: () => { quiesces += 1 },
    reconcile: async () => { reconciliations += 1 },
    repairIntervalMs: 60_000,
    waitForOwners: async () => { waits += 1 },
  })

  reconciler.wake('queued')
  const first = reconciler.drain()
  const second = reconciler.drain()
  assert.equal(first, second)
  await first
  await Promise.resolve()

  assert.equal(reconciliations, 0)
  assert.equal(quiesces, 1)
  assert.equal(waits, 1)
})

test('SIGUSR2 starts one drain and listener cleanup restores the target', async () => {
  const target = new EventEmitter()
  const completed = deferred()
  const errors: unknown[] = []
  let drains = 0
  const remove = listenForBabysitterDrainSignal(target, async () => {
    drains += 1
    await completed.promise
  }, error => errors.push(error))

  target.emit('SIGUSR2')
  target.emit('SIGUSR2')
  assert.equal(drains, 1)
  assert.equal(target.listenerCount('SIGUSR2'), 1)

  completed.resolve()
  await Promise.resolve()
  remove()
  assert.equal(target.listenerCount('SIGUSR2'), 0)
  assert.deepEqual(errors, [])
})

test('HTTP exposes drain status without an action route', async () => {
  const route = await readFile(new URL('../server/api/drain.get.ts', import.meta.url), 'utf8')
  assert.match(route, /getBabysitterDrainStatus\(\)/)
  assert.doesNotMatch(route, /drain\(/i)
  await assert.rejects(access(new URL('../server/api/drain.post.ts', import.meta.url)))
})
