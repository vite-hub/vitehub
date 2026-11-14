import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineDiagnostics } from "nostics"
import { afterEach, describe, expect, it, vi } from "vitest"

import { reportViteHubHint, viteHubHintsFile, viteHubHintsPlugin } from "../src/hints.ts"

const diagnostics = defineDiagnostics({
  docsBase: "https://vitehub.dev/docs/demo/diagnostics",
  codes: {
    DEMO_B0001: { why: "Demo counts in memory.", fix: "Use a shared store." },
    DEMO_B0002: { why: ({ file }: { file: string }) => `Demo reads ${file} at runtime.` },
  },
})

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function config(command: "build" | "serve" = "build") {
  const root = await mkdtemp(join(tmpdir(), "vitehub-hints-"))
  roots.push(root)
  return { root, command, logger: { warn: vi.fn() } }
}

const read = async (root: string) => JSON.parse(await readFile(join(root, viteHubHintsFile), "utf8"))

describe("ViteHub hints", () => {
  it("writes an empty report when the run starts, so an earlier run's hints do not stay", async () => {
    const resolved = await config()
    const plugin = viteHubHintsPlugin() as { configResolved: (config: unknown) => void }
    plugin.configResolved(resolved)
    expect(await read(resolved.root)).toMatchObject({ version: 1, command: "build", hints: [] })
  })

  it("prints each hint once with its fix and docs, and lists it in the report", async () => {
    const resolved = await config()
    // A Vite environment passes its own config object for the same project.
    const environment = { ...resolved }
    reportViteHubHint(resolved, diagnostics.DEMO_B0001())
    reportViteHubHint(environment, diagnostics.DEMO_B0001())
    reportViteHubHint(environment, Object.assign(diagnostics.DEMO_B0002({ file: "a.ts" }), { sources: ["src/a.ts:3:1"] }))

    expect(resolved.logger.warn).toHaveBeenCalledTimes(2)
    expect(resolved.logger.warn.mock.calls[0]![0]).toContain("Use a shared store.")
    expect(resolved.logger.warn.mock.calls[0]![0]).toContain("https://vitehub.dev/docs/demo/diagnostics/demo_b0001")
    expect((await read(resolved.root)).hints).toEqual([
      { code: "DEMO_B0001", why: "Demo counts in memory.", fix: "Use a shared store.", docs: "https://vitehub.dev/docs/demo/diagnostics/demo_b0001" },
      { code: "DEMO_B0002", why: "Demo reads a.ts at runtime.", docs: "https://vitehub.dev/docs/demo/diagnostics/demo_b0002", sources: ["src/a.ts:3:1"] },
    ])
  })

  it("starts a new report for a new run of the same project", async () => {
    const first = await config()
    reportViteHubHint(first, diagnostics.DEMO_B0001())
    const second = { ...first, logger: { warn: vi.fn() } }
    ;(viteHubHintsPlugin() as { configResolved: (config: unknown) => void }).configResolved(second)
    expect((await read(first.root)).hints).toEqual([])
    reportViteHubHint(second, diagnostics.DEMO_B0001())
    expect(second.logger.warn).toHaveBeenCalledTimes(1)
  })
})
