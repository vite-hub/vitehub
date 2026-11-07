import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { cronPresets } from "../src/nuxt-cron/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

describe.each([
  ["nuxt-cron", "every job on Node"],
  ["nuxt-cron-partial", "a six-field job that stays on a serverless host"],
])("nuxt-cron with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("nuxt-cron", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      if (edit.before !== undefined) expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      // The report lists deleted files. Only kept and new files have an output snapshot.
      if (edit.after !== null) await expect(edit.after).toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})

describe("nuxt-cron presets", () => {
  it("are five-field cron strings except everySecond", () => {
    for (const [name, cron] of Object.entries(cronPresets)) expect(cron.split(" ")).toHaveLength(name === "everySecond" ? 6 : 5)
  })
})
