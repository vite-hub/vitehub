import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { parseProgram } from "@vite-hub/internal/ast"
import { describe, expect, it } from "vitest"

import { formatReport, runCodemod, runMigration, upgradeCodemods } from "../src/index.ts"
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
      const again = await runCodemod("result-tuples", { cwd, dryRun: true })
      expect(again.result.edits).toEqual([])
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  it.each([
    ["import { runWorkflow } from 'vite-hub/workflow'", "runWorkflow('sync', {})", "startWorkflow('sync', {})"],
    ["import { deferWorkflow } from 'vite-hub/workflow'", "deferWorkflow('sync', {})", "startWorkflow('sync', {})"],
    ["import { createWorkflow } from 'vite-hub/workflow'\nconst handle = createWorkflow('sync')", "handle.run()", "handle.start()"],
    ["import * as workflow from 'vite-hub/workflow'", "workflow.runWorkflow('sync', {})", "workflow.startWorkflow('sync', {})"],
  ])("unwraps a renamed call in the same migration (%s)", async (imports, before, after) => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-result-tuples-verbs-"))
    try {
      await writeFile(join(cwd, "package.json"), '{"dependencies":{"vite-hub":"latest"}}')
      await writeFile(join(cwd, "run.ts"), `${imports}\nexport async function run() {\n  const value = await ${before}\n  return value.id\n}\n`)
      const migration = await runMigration({ cwd, codemods: upgradeCodemods })
      expect(migration.steps.map(step => step.codemod.name)).toEqual(["queue-workflow-verbs", "result-tuples"])
      expect(await readFile(join(cwd, "run.ts"), "utf8")).toContain(`const [valueError, value] = await ${after}\n  if (valueError) throw valueError`)
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  it("reports manual-only calls without changing evaluation order", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-result-tuples-manual-"))
    try {
      const source = `import { createWorkflow, startWorkflow } from 'vite-hub/workflow'
export const handle = createWorkflow('sync')
export function forward() { return startWorkflow('sync') }
export async function protectedReturn() {
  try { return startWorkflow('sync') }
  catch { return 'fallback' }
  finally { release() }
}
export async function argument() {
  return api.consume(await startWorkflow('sync'))
}
`
      await writeFile(join(cwd, "package.json"), "{}")
      await writeFile(join(cwd, "run.ts"), source)
      const migration = await runMigration({ cwd, codemods: upgradeCodemods })
      const followUps = migration.steps.find(step => step.codemod.name === "result-tuples")?.result?.followUps
      expect(followUps?.map(item => item.line)).toEqual([2, 3, 5, 10])
      expect(followUps?.[0]?.message).toContain("`handle` is an exported Workflow handle")
      expect(await readFile(join(cwd, "run.ts"), "utf8")).toBe(source)
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })

  it("narrows before initializing mutable variables and preserves indirect Result reads", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-result-tuples-bindings-"))
    try {
      const file = join(cwd, "run.ts")
      await writeFile(file, `import { startWorkflow } from 'vite-hub/workflow'
export async function run() {
  let mutable = await startWorkflow('sync')
  var legacy = await startWorkflow('sync')
  const tuple = await startWorkflow('sync')
  const [error, value] = tuple
  const indexed = await startWorkflow('sync')
  return [mutable.id, legacy.id, error, value, indexed[0]]
}
`)
      await runCodemod("result-tuples", { cwd })
      const migrated = await readFile(file, "utf8")
      expect(migrated).toContain("const [mutableError, run2] = await startWorkflow('sync')\n  if (mutableError) throw mutableError\n  let mutable = run2")
      expect(migrated).toContain("const [legacyError, run3] = await startWorkflow('sync')\n  if (legacyError) throw legacyError\n  var legacy = run3")
      expect(migrated).toContain("const tuple = await startWorkflow('sync')\n  const [error, value] = tuple")
      expect(migrated).toContain("const indexed = await startWorkflow('sync')")
      await expect(resultTuples.detect({ cwd })).resolves.toBeUndefined()
    }
    finally {
      await rm(cwd, { force: true, recursive: true })
    }
  })
})
