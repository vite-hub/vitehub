import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

const helper = new URL('../scripts/babysitter-drain', import.meta.url)
const mainProgram = `
const exitOnSignal = process.argv[1] === 'exit'
process.on('SIGUSR2', () => {
  process.stdout.write('SIGUSR2\\n')
  if (exitOnSignal) process.exit(0)
})
process.stdout.write('READY\\n')
setInterval(() => {}, 1000)
`

type DrainStatus = 'accepting' | 'drained' | 'draining' | 'failed' | 'starting'

async function startStatusServer(initialStatus: DrainStatus) {
  let status = initialStatus
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    close: () => closeServer(server),
    setStatus: (nextStatus: DrainStatus) => { status = nextStatus },
    url: `http://127.0.0.1:${address.port}/api/drain`,
  }
}

async function startMain(exitOnSignal = false) {
  const child = spawn(process.execPath, ['-e', mainProgram, exitOnSignal ? 'exit' : 'wait'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  child.stdout.setEncoding('utf8')
  let output = ''
  child.stdout.on('data', (chunk: string) => { output += chunk })
  await waitFor(() => output.includes('READY'))
  return { child, output: () => output }
}

function runHelper(main: ChildProcess, statusUrl: string) {
  assert.ok(main.pid)
  const child = spawn('/bin/sh', [helper.pathname, String(main.pid), statusUrl], {
    env: { ...process.env, BABYSITTER_DRAIN_POLL_SECONDS: '0.01' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  return {
    child,
    result: async () => {
      const [code, signal] = await once(child, 'exit')
      return { code, signal, stderr, stdout }
    },
  }
}

test('shell helper waits for listener readiness and exits zero when drained', async () => {
  const status = await startStatusServer('starting')
  const main = await startMain()
  try {
    const helperRun = runHelper(main.child, status.url)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.doesNotMatch(main.output(), /SIGUSR2/)

    status.setStatus('accepting')
    await waitFor(() => main.output().includes('SIGUSR2'))
    status.setStatus('drained')

    assert.deepEqual(await helperRun.result(), { code: 0, signal: null, stderr: '', stdout: '' })
  }
  finally {
    await stopMain(main.child)
    await status.close()
  }
})

test('shell helper exits nonzero when drain reports failed', async () => {
  const status = await startStatusServer('accepting')
  const main = await startMain()
  try {
    const helperRun = runHelper(main.child, status.url)
    await waitFor(() => main.output().includes('SIGUSR2'))
    status.setStatus('failed')
    const result = await helperRun.result()

    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^babysitter drain reported failed\n$/)
  }
  finally {
    await stopMain(main.child)
    await status.close()
  }
})

test('shell helper exits nonzero when the main process exits during drain', async () => {
  const status = await startStatusServer('accepting')
  const main = await startMain(true)
  try {
    const result = await runHelper(main.child, status.url).result()

    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /^babysitter main process \d+ exited before drain completed\n$/)
  }
  finally {
    await stopMain(main.child)
    await status.close()
  }
})

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('condition was not met')
}

async function stopMain(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await once(child, 'exit')
}

async function closeServer(server: Server) {
  server.close()
  await once(server, 'close')
}
