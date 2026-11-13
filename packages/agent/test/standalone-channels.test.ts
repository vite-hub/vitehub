import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { H3 } from 'h3'
import { build, createServer } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hubAgent } from '../src/vite.ts'
import { discoverStandaloneChannels, standaloneChannelWebhookAliases } from '../src/vite/standalone-channels.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function app(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-standalone-channel-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return root
}

async function server(root: string, aliases: Record<string, string> = {}) {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  await symlink(join(packageRoot, '../channels'), join(root, 'node_modules/@vite-hub/channels'), 'dir')
  await symlink(join(packageRoot, '../../node_modules/h3'), join(root, 'node_modules/h3'), 'dir')
  return await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()],
    resolve: { alias: { '@vite-hub/agent/server/internal': join(packageRoot, 'src/server/internal.ts'), ...aliases } },
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

  it('serves a suffix Channel at its default route and adapter path', async () => {
    const root = await app({ 'src/payments.channel.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
import { defineChannelTrigger } from '@vite-hub/agent/channels'
export default defineChannel({
  adapter: webhook({ signature: 'bearer', secret: 'secret', path: '/hooks/payments' }),
  on: { webhook: defineChannelTrigger({ invoke: () => Response.json({ received: true }) }) },
})
` })
    const vite = await server(root)
    try {
      const { app, routes } = await nitroApp(vite)
      expect(routes).toEqual(expect.arrayContaining(['/api/_vitehub/channels/payments', '/hooks/payments']))
      for (const path of ['/api/_vitehub/channels/payments', '/hooks/payments']) {
        expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(401)
        const delivered = await app.request(path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } })
        expect(delivered.status).toBe(200)
        expect(await delivered.json()).toEqual({ received: true })
      }
    } finally { await vite.close() }
  }, 30_000)

  it.each(['__proto__', 'toString', 'constructor'])('serves the prototype-like named Channel %s', async channelName => {
    const root = await app({
      [`server/channels/${channelName}.ts`]: `import { defineChannelTrigger } from '@vite-hub/agent/channels'
import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({ adapter: webhook(), on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName }) }) } })`,
      'server/agents/support.ts': `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ channels: [${JSON.stringify(channelName)}], runtime: false, driver: { run: () => 'ok' } })`,
    })
    const vite = await server(root)
    try {
      const { app } = await nitroApp(vite)
      const delivered = await app.request(`/api/_vitehub/channels/${channelName}`, { method: 'POST', body: '{}' })
      expect(delivered.status).toBe(200)
      expect(await delivered.json()).toEqual({ agent: 'support' })
    } finally { await vite.close() }
  }, 30_000)

  it('serves inherited named Channels through the listing child Agent', async () => {
    const channel = `import { defineChannelTrigger } from '@vite-hub/agent/channels'
import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({ adapter: webhook(), on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName }) }) } })`
    const root = await app({
      'server/channels/inherited.ts': channel,
      'server/channels/added.ts': channel,
      'server/agents/support.ts': `import { defineAgent } from '@vite-hub/agent'
const parent = defineAgent({ channels: ['inherited'], runtime: false, driver: { run: () => 'ok' } })
export default defineAgent({ extends: parent, channels: ['added'] })`,
    })
    const vite = await server(root)
    try {
      const { app } = await nitroApp(vite)
      for (const name of ['inherited', 'added']) {
        const delivered = await app.request(`/api/_vitehub/channels/${name}`, { method: 'POST', body: '{}' })
        expect(delivered.status).toBe(200)
        expect(await delivered.json()).toEqual({ agent: 'support' })
      }
    } finally { await vite.close() }
  }, 30_000)

  it('rejects an adapter path that is not a string literal', async () => {
    const root = await app({ 'server/channels/intake/index.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
const prefix = '/api'
export default defineChannel({ adapter: webhook({ path: \`\${prefix}/intake\` }) })
` })
    await expect(server(root)).rejects.toThrow(/server\/channels\/intake\/index\.ts: the adapter path must be a string literal/)
  })

  it.each([
    { name: 'direct import', binding: "import { defineAgent } from '@vite-hub/agent'", call: 'defineAgent', channels: "['hooks']" },
    { name: 'aliased import', binding: "import { defineAgent as makeAgent } from '@vite-hub/agent'", call: 'makeAgent', channels: "['hooks']" },
    { name: 'namespace import', binding: "import * as agent from '@vite-hub/agent'", call: 'agent.defineAgent', channels: "['hooks']" },
    { name: 'const list', binding: "import { defineAgent } from '@vite-hub/agent'", call: 'defineAgent', channels: "['hooks'] as const" },
    { name: 'satisfies list', binding: "import { defineAgent } from '@vite-hub/agent'", call: 'defineAgent', channels: "['hooks'] satisfies readonly string[]" },
    { name: 'comment before the list', binding: "import { defineAgent } from '@vite-hub/agent'", call: 'defineAgent', channels: "/* shared Channels */ ['hooks']" },
  ])('serves a named Channel through its Agent ($name)', async ({ name, binding, call, channels }) => {
    const channelName = name.replaceAll(' ', '-')
    const root = await app({
      [`server/channels/${channelName}.ts`]: `import { defineChannelTrigger } from '@vite-hub/agent/channels'
import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({
  adapter: webhook({ signature: 'bearer', secret: 'secret' }),
  on: { webhook: defineChannelTrigger({ invoke: context => Response.json({ agent: context.agentName, channel: context.trigger.channelId }) }) },
})
`,
      'server/agents/support.ts': `${binding}
export default ${call}({ channels: ${channels.replace('hooks', channelName)}, runtime: false, driver: { run: () => 'ok' } })
`,
    })
    const vite = await server(root)
    try {
      const { app } = await nitroApp(vite)
      for (const path of [`/api/_vitehub/channels/${channelName}`, `/api/_vitehub/agents/support/webhooks/${channelName}`]) {
        const delivered = await app.request(path, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } })
        expect(delivered.status).toBe(200)
        expect(await delivered.json()).toEqual({ agent: 'support', channel: channelName })
      }
      expect((await app.request(`/api/_vitehub/agents/channel-${channelName}/webhooks/${channelName}`, { method: 'POST', body: '{}', headers: { authorization: 'Bearer secret' } })).status).toBe(404)
    } finally { await vite.close() }
  }, 30_000)

  it.each([false, true])('rejects an eager import of the owning Agent (helper: %s)', async (helper) => {
    const root = await app({
      'server/channels/cycle.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
import { defineChannelTrigger } from '@vite-hub/agent/channels'
import owner from '${helper ? '../lib/owner' : '../agents/owner'}'
export default defineChannel({ adapter: webhook(), on: { webhook: defineChannelTrigger({ tasks: { reply: { agent: owner } }, invoke: () => ({ task: 'reply', input: { prompt: 'reply' } }) }) } })`,
      'server/lib/owner.ts': "export { default } from '../agents/owner'",
      'server/agents/owner.ts': `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ name: 'owner', channels: ['cycle'], runtime: false, driver: { run: () => 'ok' } })`,
    })
    const vite = await server(root)
    try {
      await expect(vite.ssrLoadModule(join(root, 'server/agents/owner.ts'))).rejects.toThrow(/Use a lazy task target/)
    } finally { await vite.close() }
  }, 30_000)

  it.each(['@app/server', '#server'])('rejects an eager owner import through the %s alias', async (prefix) => {
    const root = await app({
      'server/channels/cycle.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
import { defineChannelTrigger } from '@vite-hub/agent/channels'
import owner from '${prefix}/lib/owner'
export default defineChannel({ adapter: webhook(), on: { webhook: defineChannelTrigger({ tasks: { reply: { agent: owner } }, invoke: () => ({ task: 'reply', input: { prompt: 'reply' } }) }) } })`,
      'server/lib/owner.ts': `export { default } from '${prefix}/agents/owner'`,
      'server/agents/owner.ts': `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ channels: ['cycle'], runtime: false, driver: { run: () => 'ok' } })`,
    })
    const vite = await server(root, { '@app': root, '#server': join(root, 'server') })
    try {
      await expect(vite.ssrLoadModule(join(root, 'server/agents/owner.ts'))).rejects.toThrow(/Use a lazy task target/)
    } finally { await vite.close() }
    await expect(build({
      root, configFile: false, logLevel: 'silent', plugins: [hubAgent()],
      resolve: { alias: { '@app': root, '#server': join(root, 'server') } },
      build: { ssr: join(root, 'server/agents/owner.ts'), rolldownOptions: { external: /^@vite-hub\// } },
    })).rejects.toThrow(/Use a lazy task target/)
  }, 30_000)

  it.each(['agent', 'channel'])('loads an owning Agent task from the %s entry', async (entry) => {
    const root = await app({
      'server/channels/owner-task.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
import { defineChannelTrigger } from '@vite-hub/agent/channels'
export default defineChannel({
  adapter: webhook(),
  on: { webhook: defineChannelTrigger({
    tasks: { reply: { agent: () => import('../agents/owner'), prepare: () => Response.json({ target: 'owner' }) } },
    invoke: () => ({ task: 'reply', input: { prompt: 'reply' } }),
  }) },
})`,
      'server/agents/owner.ts': `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ name: 'owner', channels: ['owner-task'], runtime: false, driver: { run: () => 'ok' } })`,
    })
    const vite = await server(root)
    try {
      if (entry === 'channel') await vite.ssrLoadModule(join(root, 'server/channels/owner-task.ts'))
      const module = await vite.ssrLoadModule(join(root, 'server/agents/owner.ts'))
      expect(module.default.channels['owner-task'].triggers.webhook.tasks.reply.agent).toBeTypeOf('function')
      const { app } = await nitroApp(vite)
      const response = await app.request('/api/_vitehub/channels/owner-task', { method: 'POST', body: '{}' })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ target: 'owner' })
    } finally { await vite.close() }
  }, 30_000)

  it('ignores local, shadowed, and unrelated Agent factory calls', async () => {
    const root = await app({
      'server/channels/hooks.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({ adapter: webhook() })`,
      'server/agents/support.ts': `import { defineAgent as makeAgent } from '@vite-hub/agent'
import * as agent from '@vite-hub/agent'
function helper(makeAgent) { return makeAgent({ channels: ['parameter'] }) }
function namespaceHelper(agent) { return agent.defineAgent({ channels: ['namespace-parameter'] }) }
const unrelated = { defineAgent: value => value }
unrelated.defineAgent({ channels: ['unrelated'] })
{ const makeAgent = value => value; makeAgent({ channels: ['block'] }) }
{ const defineAgent = value => value; defineAgent({ channels: ['local'] }) }
export default makeAgent({ channels: ['hooks'], runtime: false, driver: { run: () => 'ok' } })`,
    })
    const vite = await server(root)
    try {
      const module = await vite.ssrLoadModule(join(root, 'server/agents/support.ts'))
      expect(Object.keys(module.default.channels)).toEqual(['hooks'])
    } finally { await vite.close() }
  }, 30_000)
})

describe('discoverStandaloneChannels', () => {
  it.each(['channelAdapter', 'discord', 'forgejo', 'github', 'gitlab', 'gmail', 'http', 'slack', 'teams', 'telegram', 'webChat'])('reads declared registrations from the %s adapter', async factory => {
    const args = factory === 'channelAdapter' ? "'custom', options" : 'options'
    const root = await app({ 'server/channels/hooks.ts': `import { defineChannel } from '@vite-hub/channels'
import { ${factory} as adapter } from '@vite-hub/agent/channels'
const options = { webhooks: [{ path: '/hooks', aliases: ['/old-hooks'] }, { path: '/hooks-two', aliases: ['/hooks'] }] }
export default defineChannel({ adapter: adapter(${args}) })
` })
    expect(discoverStandaloneChannels(root)[0]).toMatchObject({
      inbound: false, paths: ['/api/_vitehub/channels/hooks', '/hooks', '/old-hooks', '/hooks-two'],
    })
  })

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
    expect(discoverStandaloneChannels(root).map(({ agent, handler, inbound, name, paths }) => ({ agent, handler: handler.slice(root.length), inbound, name, paths }))).toEqual([
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
    expect(() => discoverStandaloneChannels(root)).toThrow(/the adapter aliases must be an array of string literals/)
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

describe.each(['deno', 'netlify'] as const)('%s named Channel hosting', (hosting) => {
  it.each(['webhook', 'stripe'])('allows an Agent to host a listed %s Channel', async (adapter) => {
    if (hosting === 'netlify') vi.stubEnv('VITEHUB_HOST', 'netlify')
    const root = await app({
      'server/channels/hooks.ts': `import { defineChannel, ${adapter} } from '@vite-hub/channels'
export default defineChannel({ adapter: ${adapter}({ path: '/hooks' }) })`,
      'server/agents/support.ts': `import { defineAgent as makeAgent } from '@vite-hub/agent'
export default makeAgent({ channels: ['hooks'] as const, runtime: false, driver: { run: () => 'ok' } })`,
    })
    const plugin = hubAgent({ runtime: hosting === 'deno' ? 'deno' : undefined })
    const configure = plugin.config
    if (typeof configure !== 'function') throw new Error('Expected config hook')
    expect(() => configure.call({} as never, { root }, { command: 'build', mode: 'production' })).not.toThrow()
  })

  it('still rejects the inbound Channel that no Agent lists', async () => {
    if (hosting === 'netlify') vi.stubEnv('VITEHUB_HOST', 'netlify')
    const root = await app({
      'server/channels/claimed.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({ adapter: webhook() })`,
      'server/channels/unclaimed.ts': `import { defineChannel, webhook } from '@vite-hub/channels'
export default defineChannel({ adapter: webhook() })`,
      'server/agents/support.ts': `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ channels: ['claimed'], runtime: false, driver: { run: () => 'ok' } })`,
    })
    const plugin = hubAgent({ runtime: hosting === 'deno' ? 'deno' : undefined })
    const configure = plugin.config
    if (typeof configure !== 'function') throw new Error('Expected config hook')
    expect(() => configure.call({} as never, { root }, { command: 'build', mode: 'production' })).toThrow(/unclaimed\.ts.*require a Nitro host/)
  })
})
