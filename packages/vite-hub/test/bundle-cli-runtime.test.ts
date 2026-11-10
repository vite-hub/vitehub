import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { afterEach, expect, it } from "vitest"

const execFileAsync = promisify(execFile)
const bin = new URL("../dist/bin.js", import.meta.url).pathname
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

it("reads the bundle report without loading the project", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-bundle-cli-"))
  roots.push(root)
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "bundle-cli-fixture", private: true, type: "module" }))
  await writeFile(join(root, "vite.config.mjs"), "throw new Error('the project config was loaded')\n")
  await mkdir(join(root, ".vitehub/bundle"), { recursive: true })
  await writeFile(join(root, ".vitehub/bundle/nitro.json"), JSON.stringify({
    build: "fixture-build",
    chunks: [{ bytes: 2048, entry: true, file: "index.mjs", gzip: 1024, modules: [{ bytes: 2048, dynamicImports: [], id: "server/routes/index.ts", imports: [] }], startup: true }],
    environment: "nitro",
    host: "node-server",
    outDir: ".output/server",
    schemaVersion: 1,
    side: "server",
  }))

  const { stdout } = await execFileAsync(process.execPath, [bin, "bundle"], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, timeout: 10_000 })

  expect(stdout).toContain("Bundle of the build from fixture-build for node-server")
  expect(stdout).toContain("Server: 2.0 kB of JavaScript in 1 files")
})

it("reads the configured nested root after a build without loading the config", async () => {
  const root = await mkdtemp(join(tmpdir(), "vitehub-bundle-cli-root-"))
  roots.push(root)
  const app = join(root, "packages/web")
  const configFile = join(root, "vite.config.mjs")
  await mkdir(app, { recursive: true })
  await writeFile(join(root, "package.json"), '{"type":"module"}')
  await writeFile(join(app, "package.json"), '{"type":"module"}')
  await writeFile(join(app, "entry.js"), 'console.log("nested app")')
  const buildAt = async (viteRoot: string) => {
    await writeFile(configFile, `
      import { hubBundle } from ${JSON.stringify(import.meta.resolve("@vite-hub/bundle/vite"))}
      export default {
        root: ${JSON.stringify(viteRoot)},
        plugins: [hubBundle()],
        build: { rollupOptions: { input: "entry.js" } },
      }
    `)
    await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
      import { build } from ${JSON.stringify(import.meta.resolve("vite"))}
      await build({ logLevel: "silent" })
    `], { cwd: root, timeout: 20_000 })
    await writeFile(configFile, "throw new Error('the project config was loaded')\n")
    return JSON.parse(await readFile(join(root, viteRoot, ".vitehub/bundle/client.json"), "utf8"))
  }
  const report = await buildAt("packages/web")

  const run = (args: string[]) => execFileAsync(process.execPath, [bin, "bundle", ...args], {
    cwd: root, env: { ...process.env, NO_COLOR: "1" }, timeout: 10_000,
  })
  const text = await run([])
  expect(text.stdout).toContain(`Bundle of the build from ${report.build}`)
  const json = await run(["--json"])
  expect(JSON.parse(json.stdout).build).toBe(report.build)
  const why = await run(["why", "entry.js"])
  expect(why.stdout).toContain("Client:")
  expect(why.stdout).toContain("entry.js")
  const whyJson = await run(["why", "entry.js", "--json"])
  expect(JSON.parse(whyJson.stdout).explanations).toHaveLength(1)
  await writeFile(join(root, "before.json"), json.stdout)
  const comparison = await run(["--against", "before.json", "--json"])
  expect(JSON.parse(comparison.stdout).client.delta.bytes).toBe(0)

  // Rebuilding at the workspace root must replace the old nested location.
  await writeFile(join(root, "entry.js"), 'console.log("workspace app")')
  const workspaceReport = await buildAt(".")
  expect(JSON.parse((await run(["--json"])).stdout).build).toBe(workspaceReport.build)

  // A new nested build must take priority over the report still at the workspace root.
  const nextReport = await buildAt("packages/web")
  expect(JSON.parse((await run(["--json"])).stdout).build).toBe(nextReport.build)
}, 30_000)
