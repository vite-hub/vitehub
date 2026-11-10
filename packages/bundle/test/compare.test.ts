import { cpSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { bundleCliContributor } from "../src/cli.ts"
import { collectEnvironmentReport } from "../src/collect.ts"
import { compareBundleReports, readSavedBundleReport } from "../src/compare.ts"
import { writeEnvironmentReport } from "../src/files.ts"
import { createBundleReport } from "../src/report.ts"

import type { ViteHubCliContext } from "@vite-hub/internal/cli"
import type { BundleEnvironmentReport } from "../src/types.ts"

const root = "/app"
const entry = `${root}/server/index.ts`
const zod = `${root}/node_modules/.pnpm/zod@4.1.0/node_modules/zod/index.js`
const h3 = `${root}/node_modules/h3/dist/index.mjs`
const route = `${root}/server/routes/report.ts`

/** A server build. `modules` maps a module to its bytes in the entry file; `lazy` goes to a file that loads on demand. */
function serverBuild(build: string, modules: Record<string, number>, lazy: Record<string, number> = {}): BundleEnvironmentReport {
  const size = (values: Record<string, number>) => Object.values(values).reduce((sum, bytes) => sum + bytes, 0)
  const chunks = {
    "index.mjs": { type: "chunk" as const, fileName: "index.mjs", code: "x".repeat(size(modules)), isEntry: true, facadeModuleId: entry, imports: [], modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])) },
    ...(Object.keys(lazy).length
      ? { "lazy.mjs": { type: "chunk" as const, fileName: "lazy.mjs", code: "y".repeat(size(lazy)), isEntry: false, facadeModuleId: null, imports: [], modules: Object.fromEntries(Object.entries(lazy).map(([id, renderedLength]) => [id, { renderedLength }])) } }
      : {}),
  }
  return collectEnvironmentReport(chunks, {
    build, environment: "nitro", side: "server", root, outDir: `${root}/.output/server`,
    getModuleInfo: id => ({ importedIds: [], dynamicallyImportedIds: [], isEntry: id === entry }),
  })
}

const before = serverBuild("2026-11-07T10:00:00.000Z", { [entry]: 100, [h3]: 400, [route]: 200 })
// The change: the route moves behind `import()` and starts to import zod. h3 does not change.
const after = serverBuild("2026-11-07T11:00:00.000Z", { [entry]: 120, [h3]: 400 }, { [route]: 200, [zod]: 300 })

describe("compareBundleReports", () => {
  it("gives the delta of each side and of its startup code, and the groups that changed", () => {
    const comparison = compareBundleReports(createBundleReport([before])!, createBundleReport([after])!)
    expect(comparison.builds).toEqual({ before: "2026-11-07T10:00:00.000Z", after: "2026-11-07T11:00:00.000Z" })
    expect(comparison.client).toBeUndefined()
    expect(comparison.server).toMatchObject({
      before: { bytes: 700, startupBytes: 700 },
      after: { bytes: 1020, startupBytes: 520 },
      delta: { bytes: 320, startupBytes: -180 },
    })
    expect(comparison.server!.groups).toEqual([
      { name: "zod", kind: "dependency", change: "added", before: { bytes: 0, startupBytes: 0 }, after: { bytes: 300, startupBytes: 0 }, delta: { bytes: 300, startupBytes: 0 } },
      { name: "server", kind: "app", change: "grew", before: { bytes: 100, startupBytes: 100 }, after: { bytes: 120, startupBytes: 120 }, delta: { bytes: 20, startupBytes: 20 } },
      { name: "server/routes", kind: "app", change: "shrank", before: { bytes: 200, startupBytes: 200 }, after: { bytes: 200, startupBytes: 0 }, delta: { bytes: 0, startupBytes: -200 } },
    ])
  })

  it("lists a group that went away and counts a missing side as 0 bytes", () => {
    const comparison = compareBundleReports(createBundleReport([after])!, { schemaVersion: 1, build: "empty", findings: [] })
    expect(comparison.server).toMatchObject({ after: { bytes: 0, gzip: 0, startupBytes: 0, startupGzip: 0 }, delta: { bytes: -1020 } })
    expect(comparison.server!.groups.map(group => [group.name, group.change])).toEqual([["h3", "removed"], ["zod", "removed"], ["server/routes", "removed"], ["server", "removed"]])
  })

  it("has no group changes for the same build", () => {
    const report = createBundleReport([before])!
    expect(compareBundleReports(report, report).server).toMatchObject({ delta: { bytes: 0, gzip: 0, startupBytes: 0, startupGzip: 0 }, groups: [] })
  })
})

describe("vitehub bundle --against", () => {
  function run(dir: string, args: string[]): { code: number, stdout: string, stderr: string } {
    let stdout = ""
    let stderr = ""
    const context = { cwd: dir, env: {}, rootDir: dir, spawn: async () => ({ exitCode: 0 }), stdout: { write: (text: string | Uint8Array) => { stdout += String(text) } }, stderr: { write: (text: string | Uint8Array) => { stderr += String(text) } } } as ViteHubCliContext
    const feature = bundleCliContributor.namespaces[0]!.features.find(candidate => candidate.name === (args[0] === "why" ? "why" : "report"))!
    const code = feature.run(args[0] === "why" ? args.slice(1) : args, context) as number
    return { code, stdout, stderr }
  }

  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "vitehub-bundle-compare-"))
    writeEnvironmentReport(dir, before)
    return dir
  }

  it("compares the last build with the saved --json output", () => {
    const dir = project()
    const saved = run(dir, ["--json"])
    writeFileSync(join(dir, ".vitehub/bundle-before.json"), saved.stdout)
    writeEnvironmentReport(dir, after)

    const text = run(dir, ["--against", ".vitehub/bundle-before.json"])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain("compared with the build from 2026-11-07T10:00:00.000Z")
    expect(text.stdout).toContain("Server: 700 B → 1.0 kB (+320 B)")
    expect(text.stdout).toContain("  Startup: 700 B → 520 B (-180 B)")
    expect(text.stdout).toContain("+300 B     0 B  zod (dependency), added")
    expect(text.stdout).toContain("   0 B  -200 B  server/routes (app), shrank")
    expect(text.stdout).not.toContain("h3")

    const json = JSON.parse(run(dir, [`--against=${join(dir, ".vitehub/bundle-before.json")}`, "--json"]).stdout)
    expect(json).toMatchObject({ schemaVersion: 1, server: { delta: { bytes: 320, startupBytes: -180 } } })
  })

  it("reads a copy of .vitehub/bundle/ or another project root", () => {
    const dir = project()
    const copy = join(mkdtempSync(join(tmpdir(), "vitehub-bundle-copy-")), "bundle")
    cpSync(join(dir, ".vitehub/bundle"), copy, { recursive: true })
    const otherRoot = project()
    writeEnvironmentReport(dir, after)
    expect(readSavedBundleReport(copy)!.build).toBe("2026-11-07T10:00:00.000Z")
    expect(JSON.parse(run(dir, ["--against", copy, "--json"]).stdout).server.delta.bytes).toBe(320)
    expect(JSON.parse(run(dir, ["--against", otherRoot, "--json"]).stdout).server.delta.bytes).toBe(320)
  })

  it("says when both reports are from the same build", () => {
    const dir = project()
    const result = run(dir, ["--against", "."])
    expect(result.stdout).toContain("Both reports are from the same build.")
    expect(result.stdout).toContain("Server: no change, 700 B. Startup: 700 B.")
  })

  it("fails on a missing or invalid saved report and on --against without a value", () => {
    const dir = project()
    writeFileSync(join(dir, "broken.json"), "{")
    writeFileSync(join(dir, "environment.json"), JSON.stringify(before))
    for (const path of ["missing.json", "broken.json", "environment.json"]) {
      expect(run(dir, ["--against", path])).toMatchObject({ code: 1, stderr: expect.stringContaining("vitehub bundle --json > .vitehub/bundle-before.json") })
    }
    expect(run(dir, ["--against"])).toMatchObject({ code: 1, stderr: expect.stringContaining("--against <report> needs a value.") })
    expect(run(dir, ["--against", "--json"])).toMatchObject({ code: 1, stderr: expect.stringContaining("needs a value") })
    expect(run(dir, ["why", "zod", "--against", "x.json"])).toMatchObject({ code: 1, stderr: expect.stringContaining("Unknown argument --against") })
  })

  it.each(["client", "server"])("rejects incomplete or malformed saved %s sides without throwing", (side) => {
    const dir = project()
    const valid = createBundleReport([before])!.server!
    const group = valid.groups[0]!
    const malformed = [
      {},
      null,
      [],
      { ...valid, bytes: "700" },
      { ...valid, gzip: -1 },
      { ...valid, chunks: null },
      { ...valid, environments: [1] },
      { ...valid, startup: null },
      { ...valid, startup: { bytes: 700 } },
      { ...valid, startup: { ...valid.startup, gzip: "100" } },
      { ...valid, startup: { ...valid.startup, chunks: null } },
      { ...valid, groups: {} },
      { ...valid, groups: [null] },
      { ...valid, groups: [{ ...group, name: null }] },
      { ...valid, groups: [{ ...group, kind: "unknown" }] },
      { ...valid, groups: [{ ...group, bytes: "100" }] },
      { ...valid, groups: [{ ...group, startupBytes: null }] },
      { ...valid, groups: [{ ...group, modules: "1" }] },
    ]
    for (const value of malformed) {
      const path = join(dir, "invalid.json")
      writeFileSync(path, JSON.stringify({ schemaVersion: 1, build: "old", [side]: value }))
      expect(readSavedBundleReport(path)).toBeUndefined()
      expect(run(dir, ["--against", "invalid.json"])).toMatchObject({ code: 1, stderr: expect.stringContaining("No bundle report in invalid.json.") })
    }
  })
})
