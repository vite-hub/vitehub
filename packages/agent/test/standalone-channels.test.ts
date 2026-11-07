import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { H3 } from 'h3'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { hubAgent } from '../src/vite.ts'
import { discoverStandaloneChannels, standaloneChannelWebhookAliases } from '../src/vite/standalone-channels.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-standalone-channel-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return root
}

async function server(root: string) {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  await symlink(join(packageRoot, '../channels'), join(root, 'node_modules/@vite-hub/channels'), 'dir')
  await symlink(join(packageRoot, '../../node_modules/h3'), join(root, 'node_modules/h3'), 'dir')
  return await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()],
    resolve: { alias: { '@vite-hub/agent/server/internal': join(packageRoot, 'src/server/internal.ts') } },
    server: { middlewareMode: true, watch: null } })
}

async function nitroApp(server: Awaited<ReturnType<typeof createServer>>) {
  const handlers = (server.config as unknown as { nitro: { handlers: Array<{ handler: string, middleware?: boolean, route: string }> } }).nitro.handlers
  const app = new H3()
  for (const handler of handlers.filter(handler => handler.middleware)) {
    const module = await server.ssrLoadModule(handler.handler)
    app.use(async (event, next) => (await module.default(event)) ?? next())
  }
  for (const handler of handlers.filter(handler => !handler.middleware)) {
    app.all(handler.route, (await server.ssrLoadModule(handler.handler)).default)
  }
  return { app, routes: handlers.map(handler => handler.route) }
}

const intake = `import { defineChannelTrigger } from '@vite-hub/agent/channels'
import { defineChannel, webhook } from '@vite-hub/channels'
import { label } from './label'
export default defineChannel({
  adapter: webhook({ kind: 'intake', path: '/api/intake/webhook', aliases: ['/hooks/intake'], header: 'x-test-secret', secret: 'secret' }),
  on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ channel: context.trigger.channelId, label: label() }) }) },
})
`

// A helper that looks like a Channel. In a folder with an index module, it is not one.
const label = `import { defineChannel, webhook } from '@vite-hub/channels'
export const label = () => 'from helper'
export default defineChannel({ adapter: webhook({ path: '/api/label/webhook' }) })
`

describe('standalone Channel folders', () => {
  it('serves a Channel folder webhook at its path and aliases without an Agent Definition', async () => {
    const root = await app({ 'server/channels/intake/index.ts': intake, 'server/channels/intake/label.ts': label })
    const vite = await server(root)
    try {
      const { app, routes } = await nitroApp(vite)
      expect(routes).toEqual(expect.arrayContaining(['/api/intake/webhook', '/hooks/intake']))
      for (const path of ['/api/_vitehub/channels/intake', '/api/intake/webhook', '/hooks/intake', '/api/_vitehub/agents/channel-intake/webhooks/intake']) {
        expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(401)
        const delivered = await app.request(path, { method: 'POST', body: '{}', headers: { 'x-test-secret': 'secret' } })
        expect(delivered.status).toBe(200)
        expect(await delivered.json()).toEqual({ channel: 'intake', label: 'from helper' })
      }
      expect((await app.request('/api/label/webhook', { method: 'POST', body: '{}' })).status).toBe(404)
      const generated = await readFile(join(root, '.vitehub/agent/chat-webhook-route.ts'), 'utf8')
      expect(generated).toContain('"/api/intake/webhook":{"agent":"channel-intake","webhook":"intake"}')
      expect(generated).not.toContain('label')
    } finally { await vite.close() }
  }, 30_000)

  it('rejects an adapter path that is not a string literal', async () => {
    const root = await app({ 'server/channels/intake/index.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
const prefix = '/api'
export default defineChannel({ adapter: webhook({ path: \`\${prefix}/intake\` }) })
` })
    await expect(server(root)).rejects.toThrow(/server\/channels\/intake\/index\.ts: the adapter path must be a string literal/)
  })

  it('serves a Channel that an Agent lists by name through that Agent', async () => {
    const root = await app({
      'server/channels/hooks.ts': `import { defineChannelTrigger } from '@vite-hub/agent/channels'
import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({
  adapter: webhook({ signature: 'bearer', secret: 'secret' }),
  on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName, channel: context.trigger.channelId }) }) },
})
`,
      'server/agents/support.ts': `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ channels: ['hooks'], runtime: false, driver: { run: () => 'ok' } })
`,
    })
    const vite = await server(root)
    try {
      const { app } = await nitroApp(vite)
      for (const path of ['/api/_vitehub/channels/hooks', '/api/_vitehub/agents/support/webhooks/hooks']) {
        const delivered = await app.request(path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } })
        expect(delivered.status).toBe(200)
        expect(await delivered.json()).toEqual({ agent: 'support', channel: 'hooks' })
      }
      expect((await app.request('/api/_vitehub/agents/channel-hooks/webhooks/hooks', { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } })).status).toBe(404)
    } finally { await vite.close() }
  }, 30_000)
})

describe('discoverStandaloneChannels', () => {
  it('names Channels by path and reads their routes without running modules', async () => {
    const root = await app({
      'server/channels/intake/index.ts': intake,
      'server/channels/intake/label.ts': label,
      'server/channels/flat.ts': `import * as channels from 'vite-hub/channels'
const options = { path: '/flat/one', aliases: ['/flat/old'] }
const channel = channels.defineChannel({ adapter: channels.webhook({ ...options }) })
export default channel
`,
      'server/channels/teams/index.ts': `import { teams } from '@vite-hub/agent/channels'
import { defineChannel } from '@vite-hub/channels'
export default defineChannel({ adapter: teams() })
`,
      'server/channels/factory/index.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
export default function factory() { return defineChannel({ adapter: webhook({ path: '/api/factory' }) }) }
`,
    })
    expect(discoverStandaloneChannels([join(root, 'server')]).map(({ agent, handler, inbound, name, paths }) => ({ agent, handler: handler.slice(root.length), inbound, name, paths }))).toEqual([
      { agent: 'channel-flat', handler: '/server/channels/flat.ts', inbound: true, name: 'flat', paths: ['/api/_vitehub/channels/flat', '/flat/one', '/flat/old'] },
      { agent: 'channel-intake', handler: '/server/channels/intake/index.ts', inbound: true, name: 'intake', paths: ['/api/_vitehub/channels/intake', '/api/intake/webhook', '/hooks/intake'] },
      { agent: 'channel-teams', handler: '/server/channels/teams/index.ts', inbound: false, name: 'teams', paths: ['/api/_vitehub/channels/teams'] },
    ])
  })

  it('rejects aliases that are not string literals', async () => {
    const root = await app({ 'server/channels/intake/index.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
import { oldPath } from './paths'
export default defineChannel({ adapter: webhook({ path: '/api/intake', aliases: [oldPath] }) })
` })
    expect(() => discoverStandaloneChannels([join(root, 'server')])).toThrow(/the adapter aliases must be an array of string literals/)
  })
})

describe('standalone Channel aliases', () => {
  it('preserves an explicitly configured owner for a shared path', () => {
    const channels = [{ agent: 'channel-intake', handler: '/server/channels/intake.ts', inbound: true, name: 'intake', paths: ['/shared'] }]
    expect(standaloneChannelWebhookAliases(channels, { '/shared': { agent: 'support', webhook: 'github' } })).toEqual({
      '/shared': { agent: 'support', webhook: 'github' },
    })
  })
})
