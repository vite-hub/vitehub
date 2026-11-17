import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defineDiagnostics } from "nostics"
import { afterEach, describe, expect, it, vi } from "vitest"

import { reportViteHubHint, startViteHubHints, viteHubHintsFile, viteHubHintsPlugin } from "../src/hints.ts"

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
    startViteHubHints(resolved)
    expect(viteHubHintsPlugin().name).toBe("vite-hub/hints")
    expect(await read(resolved.root)).toMatchObject({ version: 1, command: "build", hints: [] })
  })

  it("writes the report at the project root when the Vite root is the app/ folder of a Nuxt app", async () => {
    const project = await mkdtemp(join(tmpdir(), "vitehub-hints-"))
    roots.push(project)
    await mkdir(join(project, "app"))
    await writeFile(join(project, "package.json"), "{}")
    await writeFile(join(project, "nuxt.config.ts"), "export default {}\n")
    const resolved = { root: join(project, "app"), command: "build" as const, logger: { warn: vi.fn() } }
    startViteHubHints(resolved)
    reportViteHubHint(resolved, diagnostics.DEMO_B0001())
    expect((await read(project)).hints).toMatchObject([{ code: "DEMO_B0001" }])
    await expect(access(join(project, "app/.vitehub"))).rejects.toMatchObject({ code: "ENOENT" })
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
    ;startViteHubHints(second)
    expect((await read(first.root)).hints).toEqual([])
    reportViteHubHint(second, diagnostics.DEMO_B0001())
    expect(second.logger.warn).toHaveBeenCalledTimes(1)
  })

  it("starts one run per build: the plugins of one build share it, the next build starts empty", async () => {
    const first = await config()
    startViteHubHints(first)
    reportViteHubHint(first, diagnostics.DEMO_B0001())
    // A second plugin of the same build keeps the hint.
    startViteHubHints(first)
    expect((await read(first.root)).hints).toHaveLength(1)
    // The next build of the same project, with the problem fixed, writes an empty report and warns again when needed.
    const second = { ...first, logger: { warn: vi.fn() } }
    startViteHubHints(second)
    expect((await read(first.root)).hints).toEqual([])
    reportViteHubHint(second, diagnostics.DEMO_B0001())
    expect(second.logger.warn).toHaveBeenCalledTimes(1)
  })
})
