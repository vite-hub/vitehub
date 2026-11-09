import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
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
