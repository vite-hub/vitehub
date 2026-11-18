import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { parseProgram } from "@vite-hub/internal/ast"
import { describe, expect, it } from "vitest"

import { formatReport, runCodemod, upgradeCodemods } from "../src/index.ts"
import { resultTuples } from "../src/result-tuples/index.ts"

const fixture = fileURLToPath(new URL("./fixtures/result-tuples/", import.meta.url))

describe("result-tuples", () => {
  it("reads the Workflow calls as Results and reports the calls it cannot change", async () => {
    const input = join(fixture, "input")
    const run = await runCodemod("result-tuples", { cwd: input, dryRun: true })
    for (const edit of run.result.edits) {
      const { after } = edit
      if (after === null) throw new Error(`result-tuples deleted ${edit.path}`)
      expect(edit.before).toBe(await readFile(join(input, edit.path), "utf8"))
      await expect(after).toMatchFileSnapshot(join(fixture, "output", edit.path))
      expect(() => parseProgram(after, { typescript: true })).not.toThrow()
    }
    expect(run.result.edits.map(edit => edit.path)).not.toContain("app/page.ts")
    await expect(formatReport(run)).toMatchFileSnapshot(join(fixture, "output", "report.txt"))
  })

  it("runs in vitehub migrate after queue-workflow-verbs", () => {
    const names = upgradeCodemods.map(codemod => codemod.name)
    expect(names.indexOf("result-tuples")).toBeGreaterThan(names.indexOf("queue-workflow-verbs"))
  })

  it("detects an app with a call to rewrite, and changes nothing the second time", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-result-tuples-"))
    try {
      await cp(join(fixture, "input"), cwd, { recursive: true })
      await expect(resultTuples.detect({ cwd })).resolves.toMatchObject({ reason: expect.stringContaining("reads a Workflow call") })
      await runCodemod("result-tuples", { cwd })
      await expect(resultTuples.detect({ cwd })).resolves.toBeUndefined()
      const again = await runCodemod("result-tuples", { cwd, dryRun: true })
      expect(again.result.edits).toEqual([])
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  it("detects an old Workflow verb that queue-workflow-verbs renames in the same vitehub migrate run", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-result-tuples-verbs-"))
    try {
      await mkdir(join(cwd, "server/api"), { recursive: true })
      await writeFile(join(cwd, "server/api/sync.post.ts"), "import { runWorkflow } from 'vite-hub/workflow'\nexport default async () => runWorkflow('sync', {})\n")
      await expect(resultTuples.detect({ cwd })).resolves.toEqual({ reason: "server/api/sync.post.ts calls runWorkflow(), which is startWorkflow() now" })
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })
})
