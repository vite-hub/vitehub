import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"

const fixture = fileURLToPath(new URL("./fixtures/driver-key/", import.meta.url))

async function migrateSource(file: string, source: string) {
  const cwd = await mkdtemp(join(tmpdir(), "vitehub-driver-key-"))
  try {
    await writeFile(join(cwd, file), source)
    return (await runCodemod("driver-key", { cwd, dryRun: true })).result
  }
  finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

describe("driver-key", () => {
  it("renames backend keys to driver and host driver values in an app", async () => {
    const input = join(fixture, "input")
    const run = await runCodemod("driver-key", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixture, "output", edit.path))
    }
    expect(run.result.edits.map(edit => edit.path)).not.toContain("app/app.config.ts")
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixture, "output", "report.txt"))
  })

  it("leaves a key that already reads driver and reports a config that sets both", async () => {
    const result = await migrateSource("vite.config.ts", "export default defineConfig({ queue: { provider: 'vercel', driver: 'cloudflare' } })\n")
    expect(result.edits).toEqual([])
    expect(result.followUps).toEqual([{ file: "vite.config.ts", line: 1, message: "`queue` sets both `provider` and `driver`. Keep one `driver`." }])
  })

  it("keeps a store whose provider is not a Workspace Store driver", async () => {
    const result = await migrateSource("utils.ts", "export const cache = { store: { provider: 'redis' } }\n")
    expect(result.edits).toEqual([])
  })
})
