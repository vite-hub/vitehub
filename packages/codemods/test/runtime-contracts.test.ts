import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { formatReport, runCodemod } from "../src/index.ts"
import { runtimeContracts } from "../src/runtime-contracts/index.ts"

const fixture = fileURLToPath(new URL("./fixtures/runtime-contracts/", import.meta.url))

describe("runtime-contracts", () => {
  it("moves the runtime, logs, and node imports, and reads checkRateLimit() as a Result", async () => {
    const input = join(fixture, "input")
    const run = await runCodemod("runtime-contracts", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixture, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixture, "output", "report.txt"))
  })

  it("detects an app that imports a moved path", async () => {
    await expect(runtimeContracts.detect({ cwd: join(fixture, "input") })).resolves.toMatchObject({ reason: expect.stringContaining("imports") })
  })
})
