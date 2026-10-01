import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contributeProviderDeploymentOutput, useProviderOutputCatalog } from '@vite-hub/internal/build/deployment-output'
import { afterEach, expect, it, vi } from 'vitest'
import { hubAgent } from '../src/vite.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('captures and finalizes each concurrent Agent build catalog', async () => {
  const plugin = hubAgent()
  const configs = await Promise.all(['first', 'second'].map(async name => {
    const root = await mkdtemp(join(tmpdir(), `vitehub-agent-${name}-`))
    roots.push(root)
    return { root, command: 'build', agent: false, plugins: [], build: { outDir: 'dist' }, resolve: { alias: [] } }
  }))
  const writes = configs.map(() => vi.fn(async () => {}))
  configs.forEach((config, index) => contributeProviderDeploymentOutput(useProviderOutputCatalog(config), {
    owner: 'schedule', rootDir: config.root, write: writes[index]!,
  }))
  const resolveConfig = plugin.configResolved as (config: unknown) => Promise<void>
  await Promise.all(configs.map(config => resolveConfig(config)))
  const start = plugin.buildStart as (this: unknown) => void
  const end = plugin.buildEnd as (this: unknown) => Promise<void>
  const close = (plugin.closeBundle as { handler: (this: unknown) => Promise<void> }).handler
  const contexts = configs.map((config, index) => ({ environment: { config: index === 0 ? config : { ...config } } }))
  contexts.forEach(context => start.call(context))
  await end.call(contexts[0])
  await close.call(contexts[0])
  expect(writes[0]).toHaveBeenCalledOnce()
  expect(writes[1]).not.toHaveBeenCalled()
  await end.call(contexts[1])
  await close.call(contexts[1])
  expect(writes[1]).toHaveBeenCalledOnce()
})
