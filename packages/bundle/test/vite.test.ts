import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "vite"
import { afterEach, expect, it } from "vitest"

import { readEnvironmentReports } from "../src/files.ts"
import { hubBundle } from "../src/vite.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-bundle-build-"))
  roots.push(root)
  writeFileSync(join(root, "package.json"), '{"type":"module"}')
  writeFileSync(join(root, "entry.js"), 'console.log("first build")')
  return root
}

it("refreshes the report when the same plugin builds the same root again", async () => {
  const root = project()
  const plugin = hubBundle()
  const config = { configFile: false as const, root, plugins: [plugin], logLevel: "silent" as const, build: { minify: false as const, rollupOptions: { input: join(root, "entry.js") } } }
  await build(config)
  const [first] = readEnvironmentReports(root)
  expect(first).toBeDefined()
  writeFileSync(join(root, "entry.js"), `console.log(${JSON.stringify("second build".repeat(20))})`)
  await build(config)
  const [second] = readEnvironmentReports(root)
  expect(second!.build).not.toBe(first!.build)
  expect(second!.chunks[0]!.bytes).toBeGreaterThan(first!.chunks[0]!.bytes)
})

it("joins client and SSR phases from separate processes and drops them on the next build", () => {
  const root = project()
  const run = (ssr: boolean) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { build } from ${JSON.stringify(import.meta.resolve("vite"))}
      import { hubBundle } from ${JSON.stringify(new URL("../dist/vite.js", import.meta.url).href)}
      await build({
        configFile: false, root: ${JSON.stringify(root)}, plugins: [hubBundle()], logLevel: "silent",
        build: { ssr: ${ssr}, outDir: ${JSON.stringify(ssr ? "dist/server" : "dist/client")},
          rollupOptions: { input: ${JSON.stringify(join(root, "entry.js"))} } }
      })
    `], { encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
  }
  run(false)
  const buildId = readEnvironmentReports(root)[0]!.build
  run(true)
  const reports = readEnvironmentReports(root)
  expect(reports.map(report => report.environment).sort()).toEqual(["client", "ssr"])
  expect(reports.every(report => report.build === buildId)).toBe(true)
  run(false)
  const next = readEnvironmentReports(root)
  expect(next.map(report => report.environment)).toEqual(["client"])
  expect(next[0]!.build).not.toBe(buildId)
})
