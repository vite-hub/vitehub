import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer, mergeConfig } from 'vite'
import { afterEach, expect, it } from 'vitest'
import { hubAgent } from '../src/vite.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

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
