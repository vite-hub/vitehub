import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, it } from "vitest"

import { codemods, formatReport, runCodemod } from "../src/index.ts"

const fixture = fileURLToPath(new URL("./fixtures/queue-workflow-verbs/", import.meta.url))
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe("queue-workflow-verbs", () => {
  it("renames the Queue and Workflow verbs and reads deferred runs with startWorkflow", async () => {
    const input = join(fixture, "input")
    const run = await runCodemod("queue-workflow-verbs", { cwd: input, dryRun: true })
    expect(run.result.edits.map(edit => edit.path)).not.toContain("server/api/untouched.get.ts")
    for (const edit of run.result.edits) {
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(edit.after).toMatchFileSnapshot(join(fixture, "output", edit.path))
    }
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixture, "output", "report.txt"))
  })

  it("detects an app that uses an old verb", async () => {
    const codemod = codemods.find(entry => entry.name === "queue-workflow-verbs")!
    await expect(codemod.detect({ cwd: join(fixture, "input") })).resolves.toEqual({ reason: "app/components/QueueButton.vue uses `runQueue`" })
    const empty = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(empty)
    await expect(codemod.detect({ cwd: empty })).resolves.toBeUndefined()
  })

  it("changes nothing on a second run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    await cp(join(fixture, "input"), cwd, { recursive: true })
    await runCodemod("queue-workflow-verbs", { cwd })
    const second = await runCodemod("queue-workflow-verbs", { cwd, dryRun: true })
    expect(second.result.edits).toEqual([])
  })
})
