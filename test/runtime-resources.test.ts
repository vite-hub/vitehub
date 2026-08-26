import assert from 'node:assert/strict'
import test from 'node:test'
import { nodeRuntimeResources } from '@vite-hub/runtime/node'

test('aborts pending Node resource reads', async () => {
  const controller = new AbortController()
  const reason = new Error('inspection cancelled')
  const signals: AbortSignal[] = []
  let abortedReads = 0
  const inspector = nodeRuntimeResources({
    readText: async (_path, options) => await new Promise<string>((_resolve, reject) => {
      assert.ok(options?.signal)
      signals.push(options.signal)
      options.signal.addEventListener('abort', () => {
        abortedReads++
        reject(options.signal?.reason)
      }, { once: true })
    }),
  })

  const pending = Promise.resolve(inspector.inspect({ signal: controller.signal }))
  while (signals.length < 2) await new Promise<void>(resolve => setImmediate(resolve))
  controller.abort(reason)
  await pending

  assert.ok(signals.every(signal => signal === controller.signal))
  assert.equal(abortedReads, signals.length)
})
