import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { packageInfos, readPackageManifest, repoRoot } from "../utils/repo"
import { readReleaseArtifactTarballs, resolveReleaseArtifactTarball } from "../utils/release-artifacts"

const execFileAsync = promisify(execFile)

async function run(command: string, args: string[], cwd: string) {
  try {
    return await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  }
  catch (error) {
    // SAFETY: execFile attaches stdout and stderr to rejected command errors.
    const failed = error as Error & { stdout?: string, stderr?: string }
    throw new Error(`${command} ${args.join(" ")} failed\n${failed.stdout || ""}${failed.stderr || ""}`, { cause: error })
  }
}

async function packAgentDependencies(packDir: string) {
  const specs: Record<string, string> = {}
  const pending = ["@vite-hub/agent"]
  const releaseTarballs = readReleaseArtifactTarballs(repoRoot)
  while (pending.length) {
    const name = pending.pop()!
    if (specs[name]) continue
    const info = packageInfos.find(info => info.packageName === name)
    if (!info) throw new Error(`Missing workspace package ${name}`)
    const manifest = readPackageManifest(info.name)
    const tarball = await resolveReleaseArtifactTarball(releaseTarballs, name, async () => {
      const { stdout } = await run("corepack", ["pnpm", "--filter", name, "pack", "--pack-destination", packDir, "--json"], repoRoot)
      const packed: unknown = JSON.parse(stdout)
      if (!packed || typeof packed !== "object" || !("filename" in packed) || typeof packed.filename !== "string") {
        throw new Error(`Missing packed filename for ${name}`)
      }
      return packed.filename
    })
    specs[name] = `file:${tarball}`
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (packageInfos.some(info => info.packageName === dependency)) pending.push(dependency)
    }
  }
  return specs
}

const generate = `
import { writeFile, mkdir } from 'node:fs/promises'
import { agentHostRoutes, hubAgent } from '@vite-hub/agent/vite'
const root = process.cwd()
await writeFile('inspect.ts', 'export const health = () => ({ ready: true }); export const workspace = (id, path) => ({ id, path })')
const routes = agentHostRoutes({ entry: 'inspect.ts', health: 'health', workspace: 'workspace' })
const result = await routes.config({ root }, { command: 'build', mode: 'production' })
await mkdir('server/agents', { recursive: true })
await writeFile('server/agents/support.ts', 'export default { driver: { run: async () => ({}) } }')
const agent = hubAgent({ providers: { state: { provider: 'memory' } }, routes: { discordGateway: true } })
await agent.configResolved({ root, command: 'build', mode: 'production', plugins: [], build: {}, resolve: {} })
await writeFile('routes.json', JSON.stringify(result.nitro.handlers))
`

const exercise = `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import * as h3 from 'h3'
const routes = JSON.parse(await readFile('routes.json', 'utf8'))
const major = process.argv[2]
process.env.VITEHUB_DISCORD_GATEWAY_SECRET = 'consumer-test-secret'
const app = major === '1' ? h3.createApp() : new h3.H3()
const router = major === '1' ? h3.createRouter() : app
for (const route of routes.filter(route => route.method === 'get')) {
  router.get(route.route, (await import(pathToFileURL(route.handler))).default)
}
router.post('/api/agents/:agent/chat', (await import('./.vitehub/agent/chat-webhook-route.ts')).default)
router.get('/api/agents/:agent/discord', (await import('./.vitehub/agent/discord-gateway-route.ts')).default)
if (major === '1') app.use(router.handler)
const fetch = major === '1' ? h3.toWebHandler(app) : request => app.fetch(request)
const health = await fetch(new Request('http://localhost/api/health'))
assert.equal(health.status, 200)
assert.deepEqual(await health.json(), { ready: true })
const workspace = await fetch(new Request('http://localhost/api/_vitehub/console/invocations/run-123/workspace?path=src%2Findex.ts'))
assert.equal(workspace.status, 200)
assert.deepEqual(await workspace.json(), { id: 'run-123', path: 'src/index.ts' })
const chat = await fetch(new Request('http://localhost/api/agents/missing/chat', { method: 'POST' }))
assert.equal(chat.status, 404)
const discord = await fetch(new Request('http://localhost/api/agents/missing/discord', { headers: { authorization: 'Bearer consumer-test-secret' } }))
assert.equal(discord.status, 404)
console.log('generated Agent routes passed on H3 ' + major)
`

it("declares the optional host peer and executes packed Agent routes with application-owned H3 1 and 2", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-agent-host-dependencies-"))
  const appDir = join(root, "app")
  const packDir = join(root, "packs")
  try {
    await Promise.all([mkdir(appDir), mkdir(packDir)])
    const specs = await packAgentDependencies(packDir)
    const dependencies: Record<string, string> = {
      "@vite-hub/agent": specs["@vite-hub/agent"]!,
      "@vite-hub/workspace": specs["@vite-hub/workspace"]!,
    }
    const writeManifest = () => writeFile(join(appDir, "package.json"), JSON.stringify({ private: true, type: "module", packageManager: "pnpm@10.33.0", dependencies }))
    await Promise.all([
      writeManifest(),
      writeFile(join(appDir, ".npmrc"), "auto-install-peers=false\nhoist=false\nnode-linker=isolated\npublic-hoist-pattern[]=\nshamefully-hoist=false\nstrict-peer-dependencies=false\n"),
      writeFile(join(appDir, "pnpm-workspace.yaml"), [
        "packages:", "  - .", "blockExoticSubdeps: false", "overrides:",
        ...Object.entries(specs).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`), "",
      ].join("\n")),
      writeFile(join(appDir, "generate.mjs"), generate),
      writeFile(join(appDir, "exercise.mjs"), exercise),
    ])
    await run("corepack", ["pnpm", "install", "--ignore-scripts", "--reporter=append-only"], appDir)
    await run(process.execPath, ["generate.mjs"], appDir)
    // Portable imports and code generation work without H3. Only the generated host routes require it.
    await run(process.execPath, ["--input-type=module", "--eval", "await import('@vite-hub/agent'); await import('@vite-hub/agent/server')"], appDir)
    await expect(run(process.execPath, ["--input-type=module", "--eval", `
      import { readFile } from 'node:fs/promises'
      import { pathToFileURL } from 'node:url'
      const routes = JSON.parse(await readFile('routes.json', 'utf8'))
      await import(pathToFileURL(routes[0].handler))
    `], appDir)).rejects.toThrow(/Cannot find package 'h3'/)
    const manifest: unknown = JSON.parse(await readFile(join(appDir, "node_modules/@vite-hub/agent/package.json"), "utf8"))
    expect(manifest).toMatchObject({
      peerDependencies: { h3: "^1.15.11 || ^2.0.1-rc.31" },
      peerDependenciesMeta: { h3: { optional: true } },
    })
    for (const [major, version] of [["1", "1.15.11"], ["2", "2.0.1-rc.31"]]) {
      dependencies.h3 = version!
      await writeManifest()
      await run("corepack", ["pnpm", "install", "--ignore-scripts", "--reporter=append-only"], appDir)
      const { stdout } = await run(process.execPath, ["exercise.mjs", major!], appDir)
      expect(stdout).toContain(`generated Agent routes passed on H3 ${major}`)
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 600_000)
