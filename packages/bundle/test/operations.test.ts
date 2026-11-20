import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOperationRegistry, operationToolName, runOperation } from "@vite-hub/internal/operations"
import { afterEach, describe, expect, it } from "vitest"

import { collectEnvironmentReport } from "../src/collect.ts"
import { writeEnvironmentReport } from "../src/files.ts"
import { bundleOperations } from "../src/operations.ts"
import { hubBundle } from "../src/vite.ts"

import type { OperationContext } from "@vite-hub/internal/operations"
import type { OutputChunkLike } from "../src/collect.ts"

const registry = createOperationRegistry([{ operations: bundleOperations }])
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vitehub-bundle-operations-"))
  roots.push(root)
  return root
}

function chunk(fileName: string, modules: Record<string, number>, entry?: string): OutputChunkLike {
  return {
    type: "chunk", fileName, code: "x".repeat(Object.values(modules).reduce((sum, bytes) => sum + bytes, 0)), isEntry: Boolean(entry), facadeModuleId: entry ?? null, imports: [],
    modules: Object.fromEntries(Object.entries(modules).map(([id, renderedLength]) => [id, { renderedLength }])),
  }
}

/** Writes `.vitehub/bundle/nitro.json`: a server build whose entry imports `@libsql/client` at startup. */
function build(root: string): void {
  const entry = join(root, "server/index.ts")
  const libsql = join(root, "node_modules/@libsql/client/web.js")
  writeEnvironmentReport(root, collectEnvironmentReport({ "index.mjs": chunk("index.mjs", { [entry]: 100, [libsql]: 400 }, entry) }, {
    build: "2026-11-17T10:00:00.000Z-test", environment: "nitro", side: "server", root, outDir: join(root, ".output/server"),
    getModuleInfo: id => ({ importedIds: id === entry ? [libsql] : [], dynamicallyImportedIds: [], isEntry: id === entry }),
  }))
}

function context(projectRoot?: string): OperationContext {
  return { access: { mode: "local", sections: "all" }, development: projectRoot !== undefined, ...(projectRoot ? { projectRoot } : {}), surface: "mcp", user: null }
}

describe("bundle operations", () => {
  it("are the read-only MCP tools bundle_report and bundle_why", () => {
    expect(registry.list().map(operation => [operationToolName(operation.name), operation.kind, operation.section])).toEqual([
      ["bundle_report", "read", "bundle"],
      ["bundle_why", "read", "bundle"],
    ])
  })

  it("read the report in .vitehub/bundle/ of the dev server's project and explain one module", async () => {
    const root = project()
    build(root)
    expect(await runOperation(registry, "bundle.report", {}, context(root))).toMatchObject({
      ok: true,
      value: { build: "2026-11-17T10:00:00.000Z-test", server: { bytes: 500, startup: { bytes: 500 }, groups: [{ name: "@libsql/client", bytes: 400, startupBytes: 400 }, { name: "server", bytes: 100 }] } },
    })
    expect(await runOperation(registry, "bundle.why", { target: " @libsql/client " }, context(root))).toEqual({
      ok: true,
      value: {
        target: "@libsql/client",
        explanations: [{
          bytes: 400,
          chain: [{ environment: "nitro", id: "server/index.ts" }, { environment: "nitro", id: "node_modules/@libsql/client/web.js" }],
          group: "@libsql/client",
          side: "server",
          startup: true,
          target: "node_modules/@libsql/client/web.js",
        }],
      },
    })
    expect(await runOperation(registry, "bundle.why", { target: "zod" }, context(root))).toEqual({ ok: true, value: { target: "zod", explanations: [] } })
  })

  it("say how to write a report when the project has none", async () => {
    const root = project()
    for (const name of ["bundle.report", "bundle.why"]) {
      expect(await runOperation(registry, name, name === "bundle.why" ? { target: "zod" } : {}, context(root))).toMatchObject({
        ok: false, code: "BUNDLE_REPORT_MISSING", status: 404, fix: expect.stringContaining("bundle: true"),
      })
    }
  })

  it("refuse on a server that is not a dev server, even when the files exist", async () => {
    const root = project()
    build(root)
    expect(await runOperation(registry, "bundle.report", {}, context())).toMatchObject({ ok: false, code: "BUNDLE_DEV_SERVER_REQUIRED", status: 409, fix: expect.stringContaining("vitehub bundle") })
    expect(await runOperation(registry, "bundle.report", {}, { ...context(root), development: false })).toMatchObject({ ok: false, code: "BUNDLE_DEV_SERVER_REQUIRED" })
  })

  it("reject an empty target", async () => {
    expect(await runOperation(registry, "bundle.why", { target: " " }, context(project()))).toMatchObject({ ok: false, status: 400 })
  })
})

describe("bundle plugin", () => {
  it("contributes the operations", async () => {
    const [entry] = hubBundle().vitehub.operations
    expect(entry).toMatchObject({ export: "bundleOperations", module: expect.stringMatching(/packages\/bundle\/(src|dist)\/operations\.(ts|js)$/) })
    expect(await entry!.load!()).toBe(bundleOperations)
  })
})
