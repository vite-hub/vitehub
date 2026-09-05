import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { processAgentHost } from '../src/process-host-vite.ts'
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

it.each([undefined, 'default', 'host', '$host'])('wires lifecycle and drain to export %s', async (exportName) => {
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
    expect(drain).toContain('host.status()')
    expect(result).toMatchObject({ nitro: { handlers: [{ route: '/drain' }] } })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each(['', 'host"name', 'host;throw', 'a.b'])('rejects invalid export name %j', async (exportName) => {
  const hook = processAgentHost({ entry: 'agent.ts', exportName }).config
  if (!hasRuntimeType(hook, 'function')) throw new Error('Expected a config hook')
  // SAFETY: This plugin config hook uses only the supplied config, not its Vite context.
  await expect(hook.call({} as never, {}, { command: 'build', mode: 'production' }))
    .rejects.toThrow('exportName must be a JavaScript identifier')
})
