import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { H3 } from 'h3'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { hubAgent } from '../src/vite.ts'
import { discoverStandaloneChannels } from '../src/vite/standalone-channels.ts'

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

const intake = `import { defineChannel, defineChannelTrigger } from '@vite-hub/agent/channels'
import { label } from './label'
const webhooks = { path: '/api/intake/webhook', aliases: ['/hooks/intake'], secretHeader: 'x-test-secret', secretToken: 'secret' }
export default defineChannel('intake', {
  messages: false,
  triggers: { webhook: defineChannelTrigger({ invoke: context => Response.json({ channel: context.trigger.channelId, label: label() }) }) },
  webhooks,
})
`

// A helper that looks like a Channel. In a folder with an index module, it is not one.
const label = `import { defineChannel } from '@vite-hub/agent/channels'
export const label = () => 'from helper'
export default defineChannel('label', { messages: false, webhooks: { path: '/api/label/webhook' } })
`

describe('standalone Channel folders', () => {
  it('serves a Channel folder webhook at its path and aliases without an Agent Definition', async () => {
    const root = await app({ 'server/channels/intake/index.ts': intake, 'server/channels/intake/label.ts': label })
    const vite = await server(root)
    try {
      const { app, routes } = await nitroApp(vite)
      expect(routes).toEqual(expect.arrayContaining(['/api/intake/webhook', '/hooks/intake']))
      for (const path of ['/api/intake/webhook', '/hooks/intake', '/api/_vitehub/agents/channel-intake/webhooks/intake']) {
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

  it('rejects a webhooks.path that is not a string literal', async () => {
    const root = await app({ 'server/channels/intake/index.ts': `import { defineChannel } from '@vite-hub/agent/channels'
const prefix = '/api'
export default defineChannel('intake', { messages: false, webhooks: { path: \`\${prefix}/intake\` } })
` })
    await expect(server(root)).rejects.toThrow(/server\/channels\/intake\/index\.ts: webhooks\.path must be a string literal/)
  })
})

describe('discoverStandaloneChannels', () => {
  it('names Channels like outbound discovery and reads paths without running modules', async () => {
    const root = await app({
      'server/channels/intake/index.ts': intake,
      'server/channels/intake/label.ts': label,
      'server/channels/flat.ts': `import * as channels from 'vite-hub/agent/channels'
const options = { messages: false, webhooks: [{ path: '/flat/one' }, { path: '/flat/two', aliases: ['/flat/old'] }] }
const channel = channels.defineChannel('flat', { ...options })
export default channel
`,
      'server/channels/attached/index.ts': `import { defineChannel } from '@vite-hub/agent/channels'
export default defineChannel('attached', { messages: false, webhooks: true })
`,
      'server/channels/factory/index.ts': `import { defineChannel } from '@vite-hub/agent/channels'
export default function factory() { return defineChannel('factory', { webhooks: { path: '/api/factory' } }) }
`,
      'server/channels/outbound/index.ts': `export const connectors = { default: { send: () => ({ id: '1' }) } }
export default { webhooks: { path: '/api/outbound' } }
`,
    })
    expect(discoverStandaloneChannels([join(root, 'server')]).map(({ agent, handler, name, paths }) => ({ agent, handler: handler.slice(root.length), name, paths }))).toEqual([
      { agent: 'channel-flat', handler: '/server/channels/flat.ts', name: 'flat', paths: ['/flat/one', '/flat/two', '/flat/old'] },
      { agent: 'channel-intake', handler: '/server/channels/intake/index.ts', name: 'intake', paths: ['/api/intake/webhook', '/hooks/intake'] },
    ])
  })

  it('rejects aliases that are not string literals', async () => {
    const root = await app({ 'server/channels/intake/index.ts': `import { defineChannel } from '@vite-hub/agent/channels'
import { oldPath } from './paths'
export default defineChannel('intake', { webhooks: { path: '/api/intake', aliases: [oldPath] } })
` })
    expect(() => discoverStandaloneChannels([join(root, 'server')])).toThrow(/webhooks\.aliases must be an array of string literals/)
  })
})
