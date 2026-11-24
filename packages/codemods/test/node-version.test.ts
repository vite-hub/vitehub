import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { minVersion } from "semver"
import { afterEach, describe, expect, it, vi } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { nodeVersionNote, viteHubNodeFloor } from "../src/shared/node-version.ts"

describe("nodeVersionNote", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("names the shell version when it is below the vite-hub floor", () => {
    expect(nodeVersionNote("22.12.0")).toContain("vite-hub needs Node 24.15+; this shell runs 22.12.0.")
  })

  it("adds nothing on the vite-hub floor or later", () => {
    expect(nodeVersionNote("24.15.0")).toBeUndefined()
    expect(nodeVersionNote("26.1.0")).toBeUndefined()
  })

  it("matches the engines of the vite-hub package", async () => {
    const manifest: { engines: { node: string } } = JSON.parse(await readFile(new URL("../../vite-hub/package.json", import.meta.url), "utf8"))
    expect(minVersion(manifest.engines.node)?.version).toBe(viteHubNodeFloor)
  })

  it("puts the note in the codemod report on an older Node", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: "22.12.0" } })
    const run = await runCodemod("nuxt-safe-runtime-config", { cwd: fileURLToPath(new URL("./fixtures/env-schema/input", import.meta.url)), dryRun: true })
    expect(formatReport(run)).toContain("  - vite-hub needs Node 24.15+; this shell runs 22.12.0.")
  })
})
