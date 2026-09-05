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
