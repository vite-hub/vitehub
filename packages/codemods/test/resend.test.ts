import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url))

describe.each([
  ["nuxt-resend", "the nuxt-resend module and useResend()"],
  ["resend-sdk", "Resend SDK clients in server code"],
])("resend with %s", (name, label) => {
  it(`migrates ${label}`, async () => {
    const input = join(fixtures, name, "input")
    const run = await runCodemod("resend", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after ?? "(deleted)\n").toMatchFileSnapshot(join(fixtures, name, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixtures, name, "output", "report.txt"))
  })
})
