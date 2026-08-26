import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const viteHubRoot = dirname(require.resolve('vite-hub/package.json'))
const scheduleVite = require.resolve('@vite-hub/schedule/vite', { paths: [viteHubRoot] })
const scheduleProcess = require.resolve('@vite-hub/schedule/runtime/process', { paths: [viteHubRoot] })
const { createScheduleNitroConfig } = await import(pathToFileURL(scheduleVite).href)
const { createProcessScheduleWakeDriver } = await import(pathToFileURL(scheduleProcess).href)

test('closes process schedule admission as soon as shutdown is signalled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'babysitter-schedule-shutdown-'))
  t.after(async () => await rm(root, { force: true, recursive: true }))
  await writeFile(join(root, 'package.json'), '{}\n')

  await createScheduleNitroConfig({
    command: 'build',
    nitro: {},
    root,
    runtime: { driver: 'process', intervalMs: 1_000 },
  })
  const plugin = await readFile(join(root, '.vitehub/nitro/schedule/plugin.ts'), 'utf8')

  assert.match(plugin, /const shutdownSignals: NodeJS\.Signals\[\] = \['SIGINT', 'SIGTERM'\]/)
  assert.match(plugin, /prependOnceListener\(signal, closeRuntimeOnSignal\)/)
  assert.match(plugin, /function closeRuntimeOnSignal\(signal: NodeJS\.Signals\) \{[\s\S]*closeRuntime\(\)/)
  assert.doesNotMatch(plugin, /setTimeout/)
  assert.match(plugin, /nitroApp\.hooks\.hook\('close', closeRuntime\)/)
})

test('drops queued wakes while an active wake drains during close', async () => {
  const started: string[] = []
  let releaseActive!: () => void
  let markActiveStarted!: () => void
  const active = new Promise<void>(resolve => releaseActive = resolve)
  const activeStarted = new Promise<void>(resolve => markActiveStarted = resolve)
  const driver = createProcessScheduleWakeDriver({
    concurrency: 1,
    intervalMs: 60_000,
    now: () => new Date('2026-08-23T18:00:00.000Z'),
  })({
    reportError(error: unknown) {
      throw error
    },
    async wake({ scheduleId }: { scheduleId: string }) {
      started.push(scheduleId)
      if (scheduleId === 'active') {
        markActiveStarted()
        await active
      }
    },
  })
  const record = (id: string) => ({
    createdAt: new Date(0),
    cron: '* * * * *',
    enabled: true,
    id,
    target: id,
    updatedAt: new Date(0),
  })

  await driver.reconcile([record('active'), record('queued')])
  await activeStarted
  let closed = false
  const closing = driver.close().then(() => closed = true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, false)
  releaseActive()
  await closing
  assert.deepEqual(started, ['active'])
})
