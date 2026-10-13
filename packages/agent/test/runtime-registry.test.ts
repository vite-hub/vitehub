import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { H3 } from 'h3'
import { createServer, mergeConfig } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'
import { VITEHUB_NITRO_CONFIG_CONTEXT } from '@vite-hub/internal/build/vite'
import { hubAgent } from '../src/vite.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function declaredWebhookServer(names = ['support'], aliases = {}) {
  const { root } = await fixture(false)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  await symlink(join(packageRoot, '../../node_modules/h3'), join(root, 'node_modules/h3'), 'dir')
  await mkdir(join(root, 'server/agents'), { recursive: true })
  const source = `import { defineAgent } from '@vite-hub/agent'
import { defineChannel, defineChannelTrigger } from '@vite-hub/agent/channels'
export default defineAgent({ runtime: false, driver: { run: () => 'unused' }, channels: {
  productlane: defineChannel('productlane', {
    messages: false,
    history: { key: item => item.id, collection: {
      parseQuery: async query => query,
      page: async () => ({ items: [{ id: 'm1' }], nextCursor: null }),
    } },
    triggers: { webhook: defineChannelTrigger({ invoke: () => Response.json({ ok: true }) }) },
    webhooks: { path: '/api/productlane/webhook', secretHeader: 'x-test-secret', secretToken: 'secret' },
  }),
} })`
  await Promise.all(names.map(name => writeFile(join(root, `server/agents/${name}.ts`), source)))
  return await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent({ routes: { aliases } })],
    resolve: { alias: { '@vite-hub/agent/server/internal': join(packageRoot, 'src/server/internal.ts') } },
    server: { middlewareMode: true, watch: null } })
}

async function declaredWebhookApp(server: Awaited<ReturnType<typeof createServer>>) {
  const handlers = (server.config as unknown as { nitro: { handlers: Array<{ handler: string, middleware?: boolean, route: string }> } }).nitro.handlers
  const middleware = handlers.find(handler => handler.middleware && handler.handler.endsWith('/declared-webhook-route.ts'))
  expect(middleware).toMatchObject({ route: '/**' })
  const module = await server.ssrLoadModule(middleware!.handler)
  const app = new H3().use(async (event, next) => (await module.default(event)) ?? next())
  for (const handler of handlers.filter(handler => !handler.middleware)) {
    app.all(handler.route, (await server.ssrLoadModule(handler.handler)).default)
  }
  return app.post('/unrelated', event => event.req.text())
}

it('serves declared webhook paths through Nitro middleware with HEAD, authentication, and history', async () => {
  const server = await declaredWebhookServer()
  try {
    const app = await declaredWebhookApp(server)
    for (const path of ['/api/productlane/webhook', '/api/productlane/webhook/', '/api/_vitehub/agents/support/webhooks/productlane']) {
      const head = await app.request(path, { method: 'HEAD' })
      expect(head.status).toBe(204)
      expect(head.headers.get('x-vitehub-channel-provider')).toBe('productlane')
      expect((await app.request(path, { method: 'POST', body: '{}' })).status).toBe(401)
      expect((await app.request(path, { method: 'GET' })).status).toBe(405)
      const delivered = await app.request(path, { method: 'POST', body: '{}', headers: { 'x-test-secret': 'secret' } })
      expect(delivered.status).toBe(200)
      expect(await delivered.json()).toEqual({ ok: true })
      const history = await app.request(path, { method: 'POST', body: '{}', headers: { 'x-test-secret': 'secret', 'x-vitehub-channel-history': '1' } })
      expect(history.status).toBe(200)
      expect(await history.json()).toMatchObject({ items: [{ key: 'm1', item: { id: 'm1' } }] })
    }
    expect(await (await app.request('/unrelated', { method: 'POST', body: 'untouched' })).text()).toBe('untouched')
    expect((await app.request('/missing')).status).toBe(404)
  } finally { await server.close() }
}, 30_000)

it('selects a shared declared webhook path by public origin and rejects unresolved ownership', async () => {
  const server = await declaredWebhookServer(['bot', 'bot-dev'])
  const global = globalThis as typeof globalThis & { __VITEHUB_PUBLIC_URL__?: unknown }
  const previous = global.__VITEHUB_PUBLIC_URL__
  global.__VITEHUB_PUBLIC_URL__ = { agents: { bot: 'https://agent.example.com', 'bot-dev': 'https://agent-dev.example.com' } }
  try {
    const app = await declaredWebhookApp(server)
    for (const [origin, agent] of [['https://agent.example.com', 'bot'], ['https://agent-dev.example.com', 'bot-dev'], ['http://agent-dev.example.com', 'bot-dev']]) {
      const response = await app.request(`${origin}/api/productlane/webhook`, { method: 'POST', body: '{}', headers: { 'x-test-secret': 'secret', 'x-vitehub-channel-history': '1' } })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ agent })
    }
    expect((await app.request('/api/productlane/webhook', { method: 'HEAD' })).status).toBe(409)
  } finally {
    if (previous === undefined) delete global.__VITEHUB_PUBLIC_URL__
    else global.__VITEHUB_PUBLIC_URL__ = previous
    await server.close()
  }
}, 30_000)

it('lets an explicit webhook alias select the owner of a shared declared path', async () => {
  const server = await declaredWebhookServer(['bot', 'bot-dev'], { '/api/productlane/webhook': { agent: 'bot-dev', webhook: 'productlane' } })
  try {
    const app = await declaredWebhookApp(server)
    const response = await app.request('/api/productlane/webhook', { method: 'POST', body: '{}', headers: { 'x-test-secret': 'secret', 'x-vitehub-channel-history': '1' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ agent: 'bot-dev' })
    const repeated = await app.request('/api/productlane/webhook//', { method: 'POST', body: '{}', headers: { 'x-test-secret': 'secret', 'x-vitehub-channel-history': '1' } })
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toMatchObject({ agent: 'bot-dev' })
  } finally { await server.close() }
}, 30_000)

async function fixture(withAgent = true, withWorkspace = false, name = 'review') {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-agent-registry-'))
  roots.push(root)
  if (withAgent) {
    const folder = join(root, 'server/agents', name)
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'agent.ts'), `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ driver: { kind: 'codex', instructions: { template: 'Before.\\n{{{ instructions }}}\\nAfter.' } }, ${withWorkspace ? "workspace: { mode: 'write' }," : ''} runtime: false })`)
    await writeFile(join(folder, 'instructions.md'), 'Check migrations.')
  }
  const plugin = hubAgent()
  const config = { root, command: 'build', plugins: [], build: { outDir: 'dist' }, resolve: { alias: [] }, createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)) }
  const hook = plugin.config
  if (typeof hook !== 'function') throw new Error('Expected config hook')
  const userConfig = { root, nitro: {} }
  const result = await hook.call({} as never, userConfig, { command: 'build', mode: 'production' })
  // Vite merges the returned config into the config it passed to the hook.
  const configured = result ? mergeConfig(userConfig, result) : userConfig
  await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
  return { root, configured, plugin, config }
}

it('generates a Vite alias and an empty registry without agents', async () => {
  const { root, configured } = await fixture(false)
  const target = join(root, '.vitehub/agent/registry.mjs')
  expect(configured).toMatchObject({ resolve: { alias: { '#vitehub/agent/registry': target } } })
  expect(await readFile(target, 'utf8')).toContain('export default {}')
})

it.each(['review', '__proto__'])('bundles the published runtime lookup for %s with lazy decorated definitions and embedded Markdown', async (name) => {
  const { root, configured } = await fixture(true, false, name)
  const aliases = (configured as { resolve: { alias: Record<string, string> } }).resolve.alias
  const registry = aliases['#vitehub/agent/registry']!
  expect(configured).toMatchObject({ nitro: { alias: { '#vitehub/agent/registry': registry } } })
  expect(await readFile(registry, 'utf8')).toContain('import { resetPublicUrlAgentNames } from "@vite-hub/agent/server/registry"')
  expect(await readFile(registry, 'utf8')).toContain('\nresetPublicUrlAgentNames()\n')
  expect(await readFile(registry, 'utf8')).toContain('await import(')
  const entry = join(root, 'entry.ts')
  await writeFile(entry, `import { getAgentFromRegistry } from '@vite-hub/agent'
import registry, { metadata } from '#vitehub/agent/registry'
import { agents } from ${JSON.stringify(join(root, '.vitehub/agent/registry-agents.mjs'))}
export async function inspect() {
  const agent = await getAgentFromRegistry(${JSON.stringify(name)})
  return {
    instructions: agent.__vitehubAgentSettings.driver.instructions,
    registryNames: Object.keys(registry),
    metadataNames: Object.keys(metadata),
    identity: metadata[${JSON.stringify(name)}],
    catalogNames: Object.keys(agents),
  }
}`)
  const output = join(root, 'bundled.mjs')
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  await build({
    entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfigRaw: { compilerOptions: {} },
    plugins: [{ name: 'published-agent-registry', setup(builder) {
      builder.onResolve({ filter: /^#vitehub\/agent\/registry$/ }, () => ({ path: registry }))
      builder.onResolve({ filter: /^@vite-hub\/agent(?:\/|$)/ }, args => ({ path: join(packageRoot, manifest.exports[args.path === '@vite-hub/agent' ? '.' : `.${args.path.slice('@vite-hub/agent'.length)}`].import) }))
    } }],
  })
  // Runtime execution must not read source files or depend on a preceding webhook import.
  await rm(join(root, 'server'), { recursive: true })
  // Dependencies of the generated standalone bundle resolve beside the installed package.
  const artifact = join(join(packageRoot, 'dist'), `registry-test-${Date.now()}.mjs`)
  try {
    await writeFile(artifact, await readFile(output))
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'const mod = await import(process.argv[1]); console.log(JSON.stringify(await mod.inspect()))', pathToFileURL(artifact).href])
    expect(JSON.parse(result.stdout)).toEqual({
      instructions: { template: 'Before.\n{{{ instructions }}}\nAfter.', content: 'Check migrations.' },
      registryNames: [name],
      metadataNames: [name],
      identity: { name },
      catalogNames: [name],
    })
  } finally { await rm(artifact, { force: true }) }
}, 30_000)


it('loads discovered instructions through the Vite server registry', async () => {
  const { root } = await fixture(true, true)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  await mkdir(join(root, 'workspace-store'), { recursive: true })
  await writeFile(join(root, 'workspace-store/context.txt'), 'Owned workspace context.')
  const entry = join(root, 'entry.ts')
  await writeFile(entry, `import { defineAgent, getAgentFromRegistry, runAgent } from '@vite-hub/agent'
import { setWorkspaceRuntimeRegistry, resolveRegisteredWorkspaceDefinition } from '@vite-hub/workspace/runtime'
export async function inspect() {
  setWorkspaceRuntimeRegistry({ standalone: async () => ({ default: { sources: { context: { content: 'Standalone context.' } } } }) })
  const agent = await getAgentFromRegistry('review')
  const runnable = defineAgent({ extends: agent, name: 'registry-review', workspace: { store: { provider: 'local', root: ${JSON.stringify(join(root, 'workspace-store'))} } }, driver: { run: async ({ workspace }) => await workspace.fs.readFile('context.txt') } })
  const result = await runAgent(runnable, { runtime: 'unknown', memo: (_key, create) => create(), waitUntil: () => {} }, {})
  const standalone = await resolveRegisteredWorkspaceDefinition('standalone')
  return { result, instructions: agent.__vitehubWorkspaceAgentOptions.driver.instructions, standalone: standalone.sources.context.content }
}`)
  const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()], server: { middlewareMode: true, watch: null } })
  try {
    const module = await server.ssrLoadModule(entry)
    expect(await module.inspect()).toEqual({ result: 'Owned workspace context.', instructions: { template: 'Before.\n{{{ instructions }}}\nAfter.', content: 'Check migrations.' }, standalone: 'Standalone context.' })
  } finally { await server.close() }
}, 30_000)

it('clears external runtime aliases on each internal-first Vite SSR load', async () => {
  const { root } = await fixture(false)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const probe = join(root, 'runtime-probe.mjs')
  await writeFile(probe, "export { registerPublicUrlAgentName, resolvePublicUrl } from '@vite-hub/runtime'")
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  await symlink(join(packageRoot, '../runtime'), join(root, 'node_modules/@vite-hub/runtime'), 'dir')
  vi.stubGlobal('__VITEHUB_PUBLIC_URL__', { agents: { review: 'https://review.example' } })
  try {
    for (let load = 0; load < 2; load++) {
      const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()], server: { middlewareMode: true, watch: null } })
      try {
        const runtime = await server.ssrLoadModule(probe)
        runtime.registerPublicUrlAgentName('removed-agent', 'review')
        expect(runtime.resolvePublicUrl({ agentName: 'removed-agent' })).toBe('https://review.example')
        const internal = await server.ssrLoadModule(join(packageRoot, 'dist/server/internal.js'))
        expect(typeof internal.resetPublicUrlAgentNames).toBe('function')
        expect((await server.ssrLoadModule(join(root, '.vitehub/agent/registry.mjs'))).default).toEqual({})
        expect(runtime.resolvePublicUrl({ agentName: 'removed-agent' })).toBeUndefined()
      } finally { await server.close() }
    }
  } finally {
    vi.unstubAllGlobals()
  }
}, 30_000)


it('preserves earlier aliases across lazy loads and clears aliases when the parent registry is replaced', async () => {
  const { root, plugin, config } = await fixture()
  await writeFile(join(root, 'server/agents/review/agent.ts'), "import { defineAgent } from '@vite-hub/agent'; export default defineAgent({ name: 'explicit-review', driver: { kind: 'codex' }, runtime: false })")
  const second = join(root, 'server/agents/second')
  await mkdir(second, { recursive: true })
  await writeFile(join(second, 'agent.ts'), "import { defineAgent } from '@vite-hub/agent'; export default defineAgent({ name: 'explicit-second', driver: { kind: 'codex' }, runtime: false })")
  await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
  const entry = join(root, 'aliases.ts')
  await writeFile(entry, `import { registerPublicUrlAgentName, resolvePublicUrl } from '@vite-hub/runtime'
export async function inspect() {
  registerPublicUrlAgentName('stale', 'review')
  const { default: registry } = await import(${JSON.stringify(join(root, '.vitehub/agent/registry.mjs'))})
  const stale = resolvePublicUrl({ agentName: 'stale' })
  await registry.review()
  await registry.second()
  return { stale: stale ?? null, first: resolvePublicUrl({ agentName: 'explicit-review' }), second: resolvePublicUrl({ agentName: 'explicit-second' }) }
}`)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const artifact = join(packageRoot, 'dist', `registry-alias-test-${Date.now()}.mjs`)
  try {
    await build({
      entryPoints: [entry], outfile: artifact, bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfigRaw: { compilerOptions: {} },
      define: { __VITEHUB_PUBLIC_URL__: JSON.stringify({ agents: { review: 'https://first.example', second: 'https://second.example' } }) },
      plugins: [{ name: 'published-agent-aliases', setup(builder) {
        builder.onResolve({ filter: /^@vite-hub\/runtime$/ }, () => ({ path: join(packageRoot, '../runtime/dist/index.js') }))
        builder.onResolve({ filter: /^@vite-hub\/agent(?:\/|$)/ }, args => ({ path: join(packageRoot, manifest.exports[args.path === '@vite-hub/agent' ? '.' : `.${args.path.slice('@vite-hub/agent'.length)}`].import) }))
      } }],
    })
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', 'const mod = await import(process.argv[1]); console.log(JSON.stringify(await mod.inspect()))', pathToFileURL(artifact).href])
    expect(JSON.parse(result.stdout)).toEqual({ stale: null, first: 'https://first.example', second: 'https://second.example' })
  } finally { await rm(artifact, { force: true }) }
})

it('refreshes discovered agents and their first instructions when files are added or removed', async () => {
  const { root } = await fixture(false)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()], server: { middlewareMode: true, watch: null } })
  const registryPath = join(root, '.vitehub/agent/registry.mjs')
  const catalogPath = join(root, '.vitehub/agent/registry-agents.mjs')
  try {
    expect((await server.ssrLoadModule(registryPath)).default).toEqual({})
    const folder = join(root, 'server/agents/new-agent')
    await mkdir(folder, { recursive: true })
    const definition = join(folder, 'agent.ts')
    await writeFile(definition, "import { defineAgent } from '@vite-hub/agent'; export default defineAgent({ driver: { kind: 'codex' }, runtime: false })")
    server.watcher.emit('add', definition)
    await expect.poll(async () => Object.keys((await server.ssrLoadModule(registryPath)).default)).toEqual(['new-agent'])
    const instructions = join(folder, 'instructions.md')
    await writeFile(instructions, 'Added after server startup.')
    server.watcher.emit('add', instructions)
    await expect.poll(async () => (await readFile(catalogPath, 'utf8')).includes('Added after server startup.')).toBe(true)
    await expect.poll(async () => (await (await server.ssrLoadModule(registryPath)).default['new-agent']()).__vitehubAgentSettings.driver.instructions).toBe('Added after server startup.')
    await rm(instructions)
    server.watcher.emit('unlink', instructions)
    await expect.poll(async () => (await readFile(catalogPath, 'utf8')).includes('Added after server startup.')).toBe(false)
    await rm(definition)
    server.watcher.emit('unlink', definition)
    await expect.poll(async () => Object.keys((await server.ssrLoadModule(registryPath)).default)).toEqual([])
  } finally { await server.close() }
}, 30_000)

it('starts a real Vite dev server with the Console catch-all and the reserved invocation route', async () => {
  const { root } = await fixture()
  const server = await createServer(mergeConfig({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()], server: { port: 0, watch: null } }, {
    [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
    nitro: { handlers: [{ route: '/_vitehub/**', handler: '/console/page.get.js' }] },
  }))
  try {
    await server.listen()
    const handlers = (server.config as unknown as { nitro: { handlers: Array<{ route: string }> } }).nitro.handlers
    expect(handlers).toEqual(expect.arrayContaining([
      expect.objectContaining({ route: '/_vitehub/**' }),
      expect.objectContaining({ route: '/_vitehub/agent/invocations/dev' }),
    ]))
    expect(server.resolvedUrls?.local.length).toBeGreaterThan(0)
  } finally { await server.close() }
}, 30_000)
