import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runDrain } from '../../runtime/src/internal/drain.ts'
import { processAgentHost } from '../src/process-host-vite.ts'

it('generates the route used by the drain CLI by default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-host-plugin-'))
  try {
    const hook = processAgentHost({ entry: 'host.ts' }).config
    if (typeof hook !== 'function') throw new Error('Expected a config hook')
    // SAFETY: This plugin config hook uses only the supplied config root, not its Vite context.
    const result = await hook.call({} as never, { root }, { command: 'build', mode: 'production' })
    const drain = await readFile(join(root, '.vitehub/process-host/drain.ts'), 'utf8')
    // The CLI polls its default status URL; a drained answer makes it return without signaling this process.
    const statusUrls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      statusUrls.push(url)
      return Response.json({ status: 'drained' })
    })
    try {
      await expect(runDrain([String(process.pid)], { stderr: { write: () => true }, stdout: { write: () => true } })).resolves.toBe(0)
    } finally { vi.unstubAllGlobals() }
    expect(new URL(statusUrls[0]!).pathname).toBe('/api/drain')
    expect(drain).toContain('host.status()')
    // The generated Nitro route must match the CLI, as well as the handler file.
    expect(result).toMatchObject({ nitro: { handlers: [{ route: '/api/drain' }] } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([undefined, 'default', 'host', '$host', 'π', '变量', 'host\u200Cname', 'host\u200Dname'])('wires lifecycle and drain to export %s', async (exportName) => {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-host-export-'))
  try {
    const hook = processAgentHost({ entry: 'agent.ts', exportName, drainRoute: '/drain' }).config
    if (typeof hook !== 'function') throw new Error('Expected a config hook')
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
    // ViteHub drains the host on a stop signal before the server closes HTTP.
    expect(plugin).toMatch(/import \{ onShutdown \} from ".*runtime\/dist\/internal\/shutdown\.js"/)
    expect(plugin).toContain("onShutdown(app, 'agent.process-host', () => host.close())")
    expect(drain).toContain('host.status()')
    expect(result).toMatchObject({ nitro: { handlers: [{ route: '/drain' }] } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['', 'host"name', 'host;throw', 'a.b', '1host', '\u200Chost', '💥'])('rejects invalid export name %j', async (exportName) => {
  const hook = processAgentHost({ entry: 'agent.ts', exportName }).config
  if (typeof hook !== 'function') throw new Error('Expected a config hook')
  // SAFETY: This plugin config hook uses only the supplied config, not its Vite context.
  await expect(hook.call({} as never, {}, { command: 'build', mode: 'production' }))
    .rejects.toThrow('exportName must be a JavaScript identifier')
})
