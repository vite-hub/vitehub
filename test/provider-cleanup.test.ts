import assert from 'node:assert/strict'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

registerHooks({
  load(url, context, nextLoad) {
    if (url !== 'vitehub:test-provider-runtime') return nextLoad(url, context)
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export async function createProviderRuntime() {
          return globalThis.__vitehubTestProviderRuntime
        }
      `,
    }
  },
  resolve(specifier, context, nextResolve) {
    if (specifier === '@t3tools/provider-runtime') {
      return { shortCircuit: true, url: 'vitehub:test-provider-runtime' }
    }
    return nextResolve(specifier, context)
  },
})

async function providerAdapter() {
  const require = createRequire(import.meta.url)
  const viteHubPackage = require.resolve('vite-hub/package.json')
  const nestedRequire = createRequire(viteHubPackage)
  const agentPackage = nestedRequire.resolve('@vite-hub/agent/package.json')
  const agentDist = join(dirname(agentPackage), 'dist')
  const providerEntry = (await readdir(agentDist)).find(file => /^provider-agent-[\w-]+\.js$/.test(file))
  assert.ok(providerEntry, 'the installed agent package must contain its provider adapter bundle')
  const providerModule = await import(pathToFileURL(join(agentDist, providerEntry)).href)
  return providerModule.createProviderAgentAdapter({ provider: 'codex' })
}

function completedRuntime() {
  let releaseEvent!: () => void
  const eventReady = new Promise<void>((resolve) => { releaseEvent = resolve })
  const threadId = 'thread-test'
  const turnId = 'turn-test'
  return {
    attachmentsDirectory: '/tmp',
    async close() {},
    events: {
      async *[Symbol.asyncIterator]() {
        await eventReady
        yield {
          payload: { state: 'completed', stopReason: 'end_turn' },
          threadId,
          turnId,
          type: 'turn.completed',
        }
      },
    },
    async interruptTurn() {},
    async sendTurn() {
      releaseEvent()
      return { turnId }
    },
    async startSession() {
      return { resumeCursor: undefined, threadId }
    },
  }
}

async function waitForPath(path: string) {
  while (!await access(path).then(() => true, () => false)) await new Promise<void>(resolve => setImmediate(resolve))
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function collectCompletedProvider(workspace: object) {
  Object.assign(globalThis, { __vitehubTestProviderRuntime: completedRuntime() })
  const adapter = await providerAdapter()
  const events: unknown[] = []
  for await (const event of adapter.stream({
    context: { entries: () => [], get: () => undefined },
    input: {},
    invoker: { id: 'test', kind: 'system' },
    messages: [],
    prompt: 'test',
    runtime: { run: { threadId: 'thread-test' }, runtime: 'node', waitUntil: () => {} },
    workspace,
  })) events.push(event)
  return events
}

async function runCleanupScenario(event: Record<string, unknown>, advanceCleanupDeadline: () => void) {
  let releaseEvent!: () => void
  const eventReady = new Promise<void>((resolve) => { releaseEvent = resolve })
  let closeStarted!: () => void
  const closing = new Promise<void>((resolve) => { closeStarted = resolve })
  const never = new Promise<void>(() => {})
  const threadId = 'thread-test'
  const turnId = 'turn-test'
  const runtime = {
    attachmentsDirectory: '/tmp',
    async close() {},
    events: {
      async *[Symbol.asyncIterator]() {
        await eventReady
        yield { ...event, threadId, turnId }
      },
    },
    async interruptTurn() {},
    async sendTurn() {
      releaseEvent()
      return { turnId }
    },
    async startSession() {
      return { resumeCursor: undefined, threadId }
    },
  }
  Object.assign(globalThis, { __vitehubTestProviderRuntime: runtime })

  const workspaceSession = {
    async close() {
      closeStarted()
      return await never
    },
    async exec() {},
  }
  const adapter = await providerAdapter()
  const pending = (async () => {
    const events: unknown[] = []
    for await (const streamEvent of adapter.stream({
      context: { entries: () => [], get: () => undefined },
      input: {},
      invoker: { id: 'test', kind: 'system' },
      messages: [],
      prompt: 'test',
      runtime: { run: { threadId }, runtime: 'node', waitUntil: () => {} },
      workspace: { fs: {}, startSession: async () => workspaceSession },
    })) events.push(streamEvent)
    return events
  })()

  await closing
  advanceCleanupDeadline()
  return await Promise.race([
    pending.then(
      events => ({ events, status: 'resolved' as const }),
      (error: unknown) => ({ error, status: 'rejected' as const }),
    ),
    new Promise<{ status: 'pending' }>((resolve) => setImmediate(() => resolve({ status: 'pending' }))),
  ])
}

test('keeps a completed provider turn successful when only workspace cleanup times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const outcome = await runCleanupScenario({
    payload: { state: 'completed', stopReason: 'end_turn' },
    type: 'turn.completed',
  }, () => t.mock.timers.tick(10_000))

  assert.equal(outcome.status, 'resolved', 'error' in outcome
    ? `${String(outcome.error)} ${outcome.error instanceof AggregateError ? outcome.error.errors.map(String).join(' | ') : ''}`
    : undefined)
  assert.ok('events' in outcome && outcome.events.some((event: unknown) => (
    typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'error'
    && 'recoverable' in event
    && event.recoverable === true
    && 'error' in event
    && /cleanup failed/i.test(String(event.error))
  )))
})

test('preserves a genuine provider exit error when workspace cleanup also times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const outcome = await runCleanupScenario({
    payload: { exitKind: 'error', reason: 'Codex App Server exited.' },
    type: 'session.exited',
  }, () => t.mock.timers.tick(10_000))

  assert.equal(outcome.status, 'rejected')
  assert.ok('error' in outcome && outcome.error instanceof AggregateError)
  assert.ok(outcome.error.errors.some((error: unknown) => (
    error instanceof Error && /session exited before the turn completed/i.test(error.message)
  )), outcome.error.errors.map(String).join(' | '))
  assert.ok(outcome.error.errors.some((error: unknown) => (
    error instanceof DOMException
    && error.name === 'TimeoutError'
    && /cleanup timed out/i.test(error.message)
  )))
})

test('bounds parent memory and finishes provider root cleanup after the lifecycle deadline', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX provider cleanup regression')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = await mkdtemp(join(tmpdir(), 'vitehub-provider-cleanup-test-'))
  const release = join(fixture, 'release')
  const started = join(fixture, 'started.json')
  const executable = join(fixture, 'rm')
  const previousPath = process.env.PATH
  const previousMarker = process.env.VITEHUB_TEST_RM_STARTED
  const previousRelease = process.env.VITEHUB_TEST_RM_RELEASE
  let providerRoot: string | undefined
  process.env.PATH = `${fixture}:${previousPath || ''}`
  process.env.VITEHUB_TEST_RM_STARTED = started
  process.env.VITEHUB_TEST_RM_RELEASE = release
  await writeFile(executable, `#!/usr/bin/env node
const { existsSync, rmSync, writeFileSync } = require('node:fs')
writeFileSync(process.env.VITEHUB_TEST_RM_STARTED, JSON.stringify({ args: process.argv.slice(2), pid: process.pid }))
globalThis.retained = Buffer.alloc(32 * 1024 * 1024)
const target = process.argv.at(-1)
setInterval(() => {
  if (!existsSync(process.env.VITEHUB_TEST_RM_RELEASE)) return
  rmSync(target, { force: true, recursive: true })
  process.exit(0)
}, 10)
`)
  await chmod(executable, 0o755)
  t.after(async () => {
    process.env.PATH = previousPath
    if (previousMarker === undefined) delete process.env.VITEHUB_TEST_RM_STARTED
    else process.env.VITEHUB_TEST_RM_STARTED = previousMarker
    if (previousRelease === undefined) delete process.env.VITEHUB_TEST_RM_RELEASE
    else process.env.VITEHUB_TEST_RM_RELEASE = previousRelease
    if (providerRoot) await rm(providerRoot, { force: true, recursive: true })
    await rm(fixture, { force: true, recursive: true })
  })

  const before = process.memoryUsage().arrayBuffers
  const pending = collectCompletedProvider({
    fs: {},
    async startSession(options: { target: string }) {
      providerRoot = options.target
      return { async close() {}, async exec() {} }
    },
  })
  const first = await Promise.race([
    pending.then(() => 'completed' as const, () => 'completed' as const),
    waitForPath(started).then(() => 'started' as const),
  ])
  assert.equal(first, 'started', 'provider roots must be removed outside the parent Node process')
  const marker = JSON.parse(await readFile(started, 'utf8')) as { args: string[], pid: number }
  assert.deepEqual(marker.args, ['-rf', '--', providerRoot])
  assert.ok(process.memoryUsage().arrayBuffers - before < 8 * 1024 * 1024)

  t.mock.timers.tick(10_000)
  const outcome = await Promise.race([
    pending.then(events => ({ events, status: 'resolved' as const })),
    new Promise<{ status: 'pending' }>((resolve) => setImmediate(() => resolve({ status: 'pending' }))),
  ])
  assert.equal(outcome.status, 'resolved')
  assert.ok('events' in outcome && outcome.events.some((event: unknown) => (
    typeof event === 'object' && event !== null && 'recoverable' in event && event.recoverable === true
  )))
  assert.equal(processExists(marker.pid), true, 'the bounded remover must continue after the owner deadline')
  assert.equal(await access(providerRoot!).then(() => true, () => false), true)
  await writeFile(release, 'finish')
  while (processExists(marker.pid)) await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(await access(providerRoot!).then(() => true, () => false), false)
})

test('provider root cleanup deletes only its temporary tree', async (t) => {
  const outside = await mkdtemp(join(tmpdir(), 'vitehub-provider-preserve-test-'))
  const sentinel = join(outside, 'sentinel')
  let providerRoot: string | undefined
  await writeFile(sentinel, 'preserved')
  t.after(async () => {
    if (providerRoot) await rm(providerRoot, { force: true, recursive: true })
    await rm(outside, { force: true, recursive: true })
  })

  await collectCompletedProvider({
    fs: {},
    async startSession(options: { target: string }) {
      providerRoot = options.target
      await mkdir(join(providerRoot, 'large', 'nested'), { recursive: true })
      await writeFile(join(providerRoot, 'large', 'nested', 'file'), 'temporary')
      await symlink(outside, join(providerRoot, 'outside-link'))
      return { async close() {}, async exec() {} }
    },
  })

  assert.equal(await access(providerRoot!).then(() => true, () => false), false)
  assert.equal(await readFile(sentinel, 'utf8'), 'preserved')
})

test('aborts deferred workspace cleanup before removing the provider root', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX provider cleanup regression')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let providerRoot: string | undefined
  let closeStarted!: () => void
  const closing = new Promise<void>((resolve) => { closeStarted = resolve })

  const pending = collectCompletedProvider({
    fs: {},
    async startSession(options: { target: string }) {
      providerRoot = options.target
      await mkdir(join(providerRoot, 'large', 'nested'), { recursive: true })
      await writeFile(join(providerRoot, 'large', 'nested', 'file'), 'temporary')
      return {
        async close(options?: { abortSignal?: AbortSignal }) {
          const signal = options?.abortSignal
          assert.ok(signal, 'workspace close must receive the bounded cleanup signal')
          closeStarted()
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason)
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
        },
        async exec() {},
      }
    },
  })

  await closing
  t.mock.timers.tick(10_000)
  const events = await pending
  assert.ok(events.some((event: unknown) => (
    typeof event === 'object' && event !== null && 'recoverable' in event && event.recoverable === true
  )))
  while (await access(providerRoot!).then(() => true, () => false)) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
})
