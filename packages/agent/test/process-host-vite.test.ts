import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { installProcessHostStop, processAgentHost, type ProcessHostStopRuntime } from '../src/process-host-vite.ts'
import { hasRuntimeType } from '../src/internal/runtime-type.ts'

it('generates the route used by the drain CLI by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-host-plugin-'))
  try {
    const hook = processAgentHost({ entry: 'host.ts' }).config
    if (!hasRuntimeType(hook, 'function')) throw new Error('Expected a config hook')
    // SAFETY: This plugin config hook uses only the supplied config root, not its Vite context.
    const result = await hook.call({} as never, { root }, { command: 'build', mode: 'production' })
    const drain = await readFile(join(root, '.vitehub/process-host/drain.ts'), 'utf8')
    const cli = await readFile(new URL('../../runtime/src/drain.ts', import.meta.url), 'utf8')
    expect(cli).toContain('/api/drain')
    expect(drain).toContain('host.status()')
    // The generated Nitro route must match the CLI, as well as the handler file.
    expect(result).toMatchObject({ nitro: { handlers: [{ route: '/api/drain' }] } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, 'default', 'host', '$host', 'π', '变量', 'host\u200Cname', 'host\u200Dname'])('wires lifecycle and drain to export %s', async (exportName) => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-host-export-'))
  try {
    const hook = processAgentHost({ entry: 'agent.ts', exportName, drainRoute: '/drain' }).config
    if (!hasRuntimeType(hook, 'function')) throw new Error('Expected a config hook')
    // SAFETY: This plugin config hook uses only the supplied config root, not its Vite context.
    const result = await hook.call({} as never, { root }, { command: 'build', mode: 'production' })
    const plugin = await readFile(join(root, '.vitehub/process-host/plugin.ts'), 'utf8')
    const drain = await readFile(join(root, '.vitehub/process-host/drain.ts'), 'utf8')
    const expected = exportName && exportName !== 'default'
      ? `import { ${exportName} as host } from ${JSON.stringify(join(root, 'agent.ts'))}`
      : `import host from ${JSON.stringify(join(root, 'agent.ts'))}`
    expect(plugin).toContain(expected)
    expect(drain).toContain(expected)
    expect(plugin).toContain('host.start()')
    expect(plugin).toContain('host.close()')
    expect(plugin).toContain(`const installProcessHostStop = ${installProcessHostStop.toString()}`)
    expect(plugin).toContain('export default function(app) { installProcessHostStop(host, app) }')
    expect(drain).toContain('host.status()')
    expect(result).toMatchObject({ nitro: { handlers: [{ route: '/drain' }] } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['', 'host"name', 'host;throw', 'a.b', '1host', '\u200Chost', '💥'])('rejects invalid export name %j', async (exportName) => {
  const hook = processAgentHost({ entry: 'agent.ts', exportName }).config
  if (!hasRuntimeType(hook, 'function')) throw new Error('Expected a config hook')
  // SAFETY: This plugin config hook uses only the supplied config, not its Vite context.
  await expect(hook.call({} as never, {}, { command: 'build', mode: 'production' }))
    .rejects.toThrow('exportName must be a JavaScript identifier')
})

it('drains the host before the server closes HTTP on a stop signal', async () => {
  // The generated plugin embeds the function source, so run that source without its module scope.
  const install: typeof installProcessHostStop = new Function(`return ${installProcessHostStop.toString()}`)()
  const emitter = new EventEmitter()
  const exit = vi.fn<(code: number) => void>()
  const runtime: ProcessHostStopRuntime = {
    exit,
    listeners: signal => emitter.listeners(signal),
    off: (signal, listener) => emitter.off(signal, listener),
    on: (signal, listener) => emitter.on(signal, listener),
  }
  const order: string[] = []
  let finishDrain!: () => void
  const host = {
    close: vi.fn(() => {
      order.push('drain')
      return new Promise<void>((resolve) => { finishDrain = resolve })
    }),
    start: vi.fn(),
  }
  const closeHooks: (() => Promise<void>)[] = []
  const app = { hooks: { hook: (_name: 'close', callback: () => Promise<void>) => closeHooks.push(callback) } }
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const prior = vi.fn()
  emitter.on('SIGTERM', prior)
  try {
    install(host, app, runtime)
    // The server adds its graceful shutdown listener after Nitro plugins run.
    const closeServer = vi.fn(async () => { order.push('server') })
    emitter.on('SIGTERM', closeServer)
    await new Promise(resolve => setImmediate(resolve))

    expect(host.start).toHaveBeenCalledOnce()
    expect(closeHooks).toHaveLength(1)
    expect(emitter.listeners('SIGTERM')).toContain(prior)
    expect(emitter.listeners('SIGTERM')).not.toContain(closeServer)

    emitter.emit('SIGTERM', 'SIGTERM')
    emitter.emit('SIGTERM', 'SIGTERM')
    await new Promise(resolve => setImmediate(resolve))
    expect(order).toEqual(['drain'])
    expect(closeServer).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()

    finishDrain()
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(order).toEqual(['drain', 'server'])
    expect(closeServer).toHaveBeenCalledWith('SIGTERM')
    expect(host.close).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  } finally { info.mockRestore() }
})

it('exits when a server shutdown listener throws synchronously', async () => {
  const install: typeof installProcessHostStop = new Function(`return ${installProcessHostStop.toString()}`)()
  const emitter = new EventEmitter()
  const exit = vi.fn<(code: number) => void>()
  const runtime: ProcessHostStopRuntime = {
    exit,
    listeners: signal => emitter.listeners(signal),
    off: (signal, listener) => emitter.off(signal, listener),
    on: (signal, listener) => emitter.on(signal, listener),
  }
  const host = { close: vi.fn(async () => {}), start: vi.fn() }
  const app = { hooks: { hook: vi.fn() } }
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    install(host, app, runtime)
    emitter.on('SIGTERM', () => { throw new Error('server close failed') })
    await new Promise(resolve => setImmediate(resolve))

    emitter.emit('SIGTERM', 'SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    expect(error).toHaveBeenCalled()
  } finally {
    info.mockRestore()
    error.mockRestore()
  }
})
