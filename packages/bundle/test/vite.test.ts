import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build, createBuilder } from "vite"
import { afterEach, expect, it } from "vitest"

import { readEnvironmentReports } from "../src/files.ts"
import { hubBundle } from "../src/vite.ts"

import type { Plugin } from "vite"

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

it("refreshes the bytes within a watched build session", async () => {
  const root = project()
  const watcher = await build({ configFile: false, root, plugins: [hubBundle()], logLevel: "silent", build: { minify: false, watch: {}, rollupOptions: { input: join(root, "entry.js") } } })
  if (!("on" in watcher)) throw new Error("Expected a build watcher")
  const nextBuild = (ready = () => true) => new Promise<void>((resolve, reject) => {
    watcher.on("event", (event) => {
      if (event.code === "END" && ready()) resolve()
      else if (event.code === "ERROR") reject(event.error)
    })
  })
  try {
    await nextBuild()
    const [first] = readEnvironmentReports(root)
    const next = nextBuild(() => (readEnvironmentReports(root)[0]?.chunks[0]?.bytes ?? 0) > first!.chunks[0]!.bytes)
    writeFileSync(join(root, "entry.js"), `console.log(${JSON.stringify("watched build".repeat(20))})`)
    await next
    const [second] = readEnvironmentReports(root)
    expect(second!.build).toBe(first!.build)
    expect(second!.chunks[0]!.bytes).toBeGreaterThan(first!.chunks[0]!.bytes)
  }
  finally {
    await watcher.close()
  }
})

it.each([["ssr", "client"], ["client", "ssr"]])("starts a fresh multi-environment build in %s then %s order after an incomplete build", async (first, second) => {
  const root = project()
  const config = { configFile: false as const, root, plugins: [hubBundle()], logLevel: "silent" as const, build: { rollupOptions: { input: join(root, "entry.js") } } }
  await build(config)
  const oldBuild = readEnvironmentReports(root)[0]!.build
  const builder = await createBuilder({
    ...config,
    environments: {
      client: { build: { outDir: "dist/client" } },
      ssr: { build: { outDir: "dist/server" } },
    },
    builder: { async buildApp(app) {
      await app.build(app.environments[first!]!)
      await app.build(app.environments[second!]!)
    } },
  })
  await builder.buildApp()
  const reports = readEnvironmentReports(root)
  expect(reports.map(report => report.environment).sort()).toEqual(["client", "ssr"])
  expect(new Set(reports.map(report => report.build)).size).toBe(1)
  expect(reports[0]!.build).not.toBe(oldBuild)
  await builder.buildApp()
  const next = readEnvironmentReports(root)
  expect(next.map(report => report.environment).sort()).toEqual(["client", "ssr"])
  expect(new Set(next.map(report => report.build)).size).toBe(1)
  expect(next[0]!.build).not.toBe(reports[0]!.build)
})

it("does not combine independent SSR-only and client-only commands", async () => {
  const root = project()
  const config = { configFile: false as const, root, plugins: [hubBundle()], logLevel: "silent" as const, build: { rollupOptions: { input: join(root, "entry.js") } } }
  await build({ ...config, build: { ...config.build, ssr: true } })
  const oldBuild = readEnvironmentReports(root)[0]!.build
  await build(config)
  const reports = readEnvironmentReports(root)
  expect(reports.map(report => report.environment)).toEqual(["client"])
  expect(reports[0]!.build).not.toBe(oldBuild)
})

it.each([false, true])("joins explicitly coordinated phases in separate processes (SSR first: %s)", (ssrFirst) => {
  const root = project()
  const run = (ssr: boolean, buildId: string) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { build } from ${JSON.stringify(import.meta.resolve("vite"))}
      import { hubBundle } from ${JSON.stringify(new URL("../dist/vite.js", import.meta.url).href)}
      await build({
        configFile: false, root: ${JSON.stringify(root)}, plugins: [hubBundle({ buildId: ${JSON.stringify(buildId)} })], logLevel: "silent",
        build: { ssr: ${ssr}, outDir: ${JSON.stringify(ssr ? "dist/server" : "dist/client")},
          rollupOptions: { input: ${JSON.stringify(join(root, "entry.js"))} } }
      })
    `], { encoding: "utf8" })
    expect(result.status, result.stderr).toBe(0)
  }
  run(false, "old-command")
  run(ssrFirst, "first-command")
  const buildId = readEnvironmentReports(root)[0]!.build
  expect(buildId).toBe("first-command")
  run(!ssrFirst, "first-command")
  const reports = readEnvironmentReports(root)
  expect(reports.map(report => report.environment).sort()).toEqual(["client", "ssr"])
  expect(reports.every(report => report.build === buildId)).toBe(true)
  run(false, "next-command")
  const next = readEnvironmentReports(root)
  expect(next.map(report => report.environment)).toEqual(["client"])
  expect(next[0]!.build).not.toBe(buildId)
})

it("shares an explicit Nuxt build session across serial Vite and Nitro phases", async () => {
  const root = project()
  const plugin = hubBundle()
  const config = { configFile: false as const, root, plugins: [plugin], logLevel: "silent" as const, build: { rollupOptions: { input: join(root, "entry.js") } } }
  const nitroConfig: { rolldown: { plugins?: unknown } } = { rolldown: {} }
  plugin.nitro.setup({
    options: { dev: false, rootDir: root },
    hooks: { hook(_name, callback) { callback({}, nitroConfig) } },
  })
  const run = async () => {
    plugin.api.startBuild()
    await build(config)
    await build({ ...config, build: { ...config.build, ssr: true, outDir: "dist/ssr" } })
    await build({ ...config, plugins: nitroConfig.rolldown.plugins as Plugin[], build: { ...config.build, ssr: true, outDir: "dist/nitro" } })
  }
  await run()
  const reports = readEnvironmentReports(root)
  expect(reports.map(report => report.environment).sort()).toEqual(["client", "nitro", "ssr"])
  expect(new Set(reports.map(report => report.build)).size).toBe(1)
  await run()
  const next = readEnvironmentReports(root)
  expect(next.map(report => report.environment).sort()).toEqual(["client", "nitro", "ssr"])
  expect(new Set(next.map(report => report.build)).size).toBe(1)
  expect(next[0]!.build).not.toBe(reports[0]!.build)
})
