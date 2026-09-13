import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'vite'
import { afterEach, expect, it } from 'vitest'
import { hubAgent } from '../src/vite.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(withAgent = true, withWorkspace = false) {
  const root = await mkdtemp(join(tmpdir(), 'vitehub-agent-registry-'))
  roots.push(root)
  if (withAgent) {
    const folder = join(root, 'server/agents/review')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'agent.ts'), `import { defineAgent } from '@vite-hub/agent'
export default defineAgent({ driver: { kind: 'codex', instructions: { template: 'Before.\\n{{{ instructions }}}\\nAfter.' } }, ${withWorkspace ? "workspace: { mode: 'write' }," : ''} runtime: false })`)
    await writeFile(join(folder, 'instructions.md'), 'Check migrations.')
  }
  const plugin = hubAgent()
  const config = { root, command: 'build', plugins: [], build: { outDir: 'dist' }, resolve: { alias: [] }, createResolver: () => async (specifier: string) => fileURLToPath(import.meta.resolve(specifier)) }
  const hook = plugin.config
  if (typeof hook !== 'function') throw new Error('Expected config hook')
  const configured = await hook.call({} as never, { root, nitro: {} } as never, { command: 'build', mode: 'production' })
  await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
  return { root, configured }
}

it('generates a Vite alias and an empty registry without agents', async () => {
  const { root, configured } = await fixture(false)
  const target = join(root, '.vitehub/agent/registry.mjs')
  expect(configured).toMatchObject({ resolve: { alias: { '#vitehub/agent/registry': target } } })
  expect(await readFile(target, 'utf8')).toContain('export default {}')
})

it('bundles the published runtime lookup with lazy decorated definitions and embedded Markdown', async () => {
  const { root, configured } = await fixture()
  const aliases = (configured as { resolve: { alias: Record<string, string> } }).resolve.alias
  const registry = aliases['#vitehub/agent/registry']!
  expect(configured).toMatchObject({ nitro: { alias: { '#vitehub/agent/registry': registry } } })
  expect(await readFile(registry, 'utf8')).toContain('await import(')
  const entry = join(root, 'entry.ts')
  await writeFile(entry, `import { getAgentFromRegistry } from '@vite-hub/agent'
export async function inspect() {
  const agent = await getAgentFromRegistry('review')
  return agent.__vitehubAgentSettings.driver.instructions
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
    expect(JSON.parse(result.stdout)).toEqual({ template: 'Before.\n{{{ instructions }}}\nAfter.', content: 'Check migrations.' })
  } finally { await rm(artifact, { force: true }) }
}, 30_000)


it('loads discovered instructions through the Vite server registry', async () => {
  const { root } = await fixture(true, true)
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))
  await mkdir(join(root, 'node_modules/@vite-hub'), { recursive: true })
  await symlink(packageRoot, join(root, 'node_modules/@vite-hub/agent'), 'dir')
  await symlink(join(packageRoot, '../workspace'), join(root, 'node_modules/@vite-hub/workspace'), 'dir')
  const entry = join(root, 'entry.ts')
  await writeFile(entry, `import { getAgentFromRegistry } from '@vite-hub/agent'
export async function inspect() { return (await getAgentFromRegistry('review')).__vitehubWorkspaceAgentOptions.driver.instructions }`)
  const server = await createServer({ root, configFile: false, appType: 'custom', logLevel: 'silent', plugins: [hubAgent()], server: { middlewareMode: true, watch: null } })
  try {
    const module = await server.ssrLoadModule(entry)
    expect(await module.inspect()).toEqual({ template: 'Before.\n{{{ instructions }}}\nAfter.', content: 'Check migrations.' })
  } finally { await server.close() }
}, 30_000)
