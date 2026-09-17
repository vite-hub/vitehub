import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { expect, it } from "vitest"

import { readReleaseArtifactTarballs, resolveReleaseArtifactTarball } from "../utils/release-artifacts"

const exec = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, "../..")
const owners = ["blob", "queue", "rate-limit", "schedule"]
const dependencies = [...owners, "kv"]

async function run(args: string[], cwd: string) {
  try {
    return await exec("corepack", ["pnpm", ...args], { cwd, maxBuffer: 32 * 1024 * 1024 })
  }
  catch (error) {
    if (error instanceof Error && "stdout" in error && "stderr" in error) {
      throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}`, { cause: error })
    }
    throw error
  }
}

it("builds packed owner-generated modules with the selected Nitro host and no hoisting", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-nitro-owner-imports-"))
  try {
    const packs = join(root, "packs")
    await mkdir(packs)
    const overrides: Record<string, string> = {}
    const releaseTarballs = readReleaseArtifactTarballs(repoRoot)
    for (const name of [...dependencies, "runtime"]) {
      const packageName = `@vite-hub/${name}`
      const manifest = JSON.parse(await readFile(join(repoRoot, "packages", name, "package.json"), "utf8")) as { version: string }
      const tarball = await resolveReleaseArtifactTarball(releaseTarballs, packageName, async () => {
        await run(["--filter", packageName, "pack", "--pack-destination", packs], repoRoot)
        return join(packs, `vite-hub-${name}-${manifest.version}.tgz`)
      })
      overrides[packageName] = `file:${tarball}`
    }

    for (const version of [2, 3]) {
      const app = join(root, `nitro-${version}`)
      await mkdir(join(app, "server/schedules"), { recursive: true })
      await writeFile(join(app, "package.json"), JSON.stringify({
        private: true,
        packageManager: "pnpm@10.33.0",
        type: "module",
        dependencies: {
          ...Object.fromEntries(dependencies.map(name => [`@vite-hub/${name}`, overrides[`@vite-hub/${name}`]])),
          [version === 2 ? "nitropack" : "nitro"]: version === 2 ? "2.13.4" : "3.0.260903-beta",
          vite: "^8.0.0",
        },
      }))
      await writeFile(join(app, "pnpm-workspace.yaml"), [
        "packages: [.]",
        "autoInstallPeers: false",
        "hoist: false",
        "allowBuilds:",
        "  esbuild: true",
        "overrides:",
        ...Object.entries(overrides).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
      ].join("\n"))
      await writeFile(join(app, "server/schedules/tick.ts"), `
import { defineSchedule } from '@vite-hub/schedule'
import { kv } from '@vite-hub/kv'
export default defineSchedule({ cron: '* * * * *', async handler() { await kv.get('last-run') } })
`)
      await writeFile(join(app, "generate-and-build.mjs"), `
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveConfig } from 'vite'
import { hubBlob } from '@vite-hub/blob/vite'
import { hubKv } from '@vite-hub/kv/vite'
import { hubQueue } from '@vite-hub/queue/vite'
import { hubRateLimit } from '@vite-hub/rate-limit/vite'
import { hubSchedule } from '@vite-hub/schedule/vite'
import queueNuxt from '@vite-hub/queue/nuxt'
import scheduleNuxt from '@vite-hub/schedule/nuxt'
import { createNitro, prepare, build } from '${version === 2 ? "nitropack/core" : "nitro/builder"}'

const hooks = []
const nuxt = {
  options: { rootDir: process.cwd(), srcDir: process.cwd(), vite: {} },
  hook(name, callback) { if (name === 'nitro:config') hooks.push(callback) },
}
if (${version} === 2) {
  queueNuxt({ provider: 'cloudflare' }, nuxt)
  scheduleNuxt({ providerOutput: 'nitro' }, nuxt)
}
const hostConfig = { preset: '${version === 2 ? "cloudflare_module" : "cloudflare-module"}' }
for (const hook of hooks) await hook(hostConfig)
const config = await resolveConfig({
  configFile: false,
  root: process.cwd(),
  ...nuxt.options.vite,
  nitro: hostConfig,
  plugins: [
    ${version === 3 ? "{ name: 'nitro:main' }," : ""}
    hubBlob({ driver: 'cloudflare-r2', serve: { headers: { 'Cache-Control': 'public, max-age=3600' } } }),
    ...(nuxt.options.vite.plugins ?? [hubQueue({ provider: 'cloudflare' }), hubSchedule({ providerOutput: 'nitro' })]),
    hubRateLimit({ provider: 'cloudflare', namespace: 'packed-consumer' }),
    hubKv({ driver: 'cloudflare-kv-binding', binding: 'KV' }),
  ],
}, 'build')

const queue = config.plugins.find(plugin => plugin.name === '@vite-hub/queue/vite')
await queue.handleHotUpdate({ file: process.cwd() + '/example.queue.ts', server: { config } })
assert.ok((await readFile('.vitehub/queue.d.ts', 'utf8')).includes('@vite-hub/queue'))
const files = [
  '.vitehub/nitro/blob/middleware.ts',
  '.vitehub/blob/serve-route.ts',
  '.vitehub/nitro/queue/plugin.ts',
  '.vitehub/nitro/queue/middleware.ts',
  '.vitehub/nitro/rate-limit/plugin.ts',
  '.vitehub/nitro/schedule/plugin.ts',
]
for (const file of files) {
  const source = await readFile(file, 'utf8')
  assert.match(source, ${version === 2 ? "/from '(?:nitropack\\/runtime|h3)'/" : "/from 'nitro(?:\\/cache)?'/"})
}
// Rate Limit's installer is inert without policies, but its host import must still compile.
config.nitro.plugins.push(process.cwd() + '/.vitehub/nitro/rate-limit/plugin.ts')
// Nitro 2's Nuxt adapter forwards owner runtime resolvers into Rollup.
const runtimeResolvers = config.plugins
  .filter(plugin => ['@vite-hub/blob/vite', '@vite-hub/kv/vite'].includes(plugin.name))
  .map(plugin => ({
    name: plugin.name,
    resolveId: typeof plugin.resolveId === 'function' ? plugin.resolveId : plugin.resolveId?.handler,
    load: typeof plugin.load === 'function' ? plugin.load : plugin.load?.handler,
  }))
const nitro = await createNitro({
  ...config.nitro,
  rootDir: process.cwd(),
  compatibilityDate: '2026-09-01',
  rollupConfig: { ...config.nitro.rollupConfig, plugins: runtimeResolvers },
  noExternals: true,
})
try {
  await prepare(nitro)
  await build(nitro)
} finally {
  await nitro.close()
}
console.log('packed Nitro ${version} owner imports compiled')
`)
      await run(["install", "--no-hoist", "--strict-peer-dependencies"], app)
      const result = await run(["exec", "node", "generate-and-build.mjs"], app)
      expect(result.stdout).toContain(`packed Nitro ${version} owner imports compiled`)

      if (version === 3) {
        // Each dated prerelease needs its own semver admission. Keep development pinned,
        // but prove published peers also accept the older supported consumer hosts.
        for (const compatibleVersion of ["3.0.260603-beta", "3.0.260610-beta"]) {
          await run(["add", `nitro@${compatibleVersion}`, "--no-hoist", "--strict-peer-dependencies", "--ignore-scripts"], app)
          const installed = JSON.parse(await readFile(join(app, "node_modules/nitro/package.json"), "utf8")) as { version: string }
          expect(installed.version).toBe(compatibleVersion)
        }
      }
    }
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}, 600_000)
