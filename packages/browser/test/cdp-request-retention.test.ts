import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const run = promisify(execFile)

it.each([
  ["source", "../src/controllers/cdp.ts"],
  ["built", "../dist/controllers/cdp.js"],
])("releases failed CDP request state in the %s controller", async (_name, entry) => {
  const { stdout } = await run(process.execPath, ["--expose-gc", "--input-type=module", "-e", `
    import { setImmediate } from 'node:timers/promises'
    import { cdp } from ${JSON.stringify(new URL(entry, import.meta.url).href)}

    const references = []
    let mode = 'send'
    let sent = 0
    let rejected = 0
    function fail() {
      const error = new Error('Failed ' + mode)
      references.push(new WeakRef(error))
      throw error
    }
    class Socket extends EventTarget {
      readyState = 1
      send(data) {
        sent++
        if (mode === 'send') fail()
        const { id } = JSON.parse(data)
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: { ok: true } }) }))
      }
      close() {
        this.readyState = 3
        this.dispatchEvent(new Event('close'))
      }
    }
    const socket = new Socket()
    const attached = await cdp({ connect: async () => socket }).attach({ kind: 'cdp', endpoint: 'ws://localhost' }, {
      provider: { features: { liveHandoff: false }, isolation: 'trusted-host', name: 'local' }, sessionId: 'test',
    })
    // Keep the connection alive while collecting objects from rejected requests.
    globalThis.retainedClient = attached
    for (mode of ['send', 'serialize']) {
      for (let i = 0; i < 10; i++) {
        const params = mode === 'serialize' ? { toJSON: fail } : {}
        await attached.client.send('Target.getTargets', params).catch(() => { rejected++ })
      }
    }
    mode = 'success'
    const result = await attached.client.send('Target.getTargets')
    for (let i = 0; i < 5; i++) { await setImmediate(); globalThis.gc() }
    const retained = references.filter(reference => reference.deref()).length
    await attached.release()
    console.log(JSON.stringify({ rejected, retained, result, sent }))
  `], { timeout: 10_000 })

  expect(JSON.parse(stdout)).toEqual({
    rejected: 20,
    retained: 0,
    result: { ok: true },
    sent: 11,
  })
})
