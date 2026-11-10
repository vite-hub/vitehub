import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  it("keeps inline type imports, shadowed namespaces, and Workflow aliases safe", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    await writeFile(join(cwd, "contracts.ts"), [
      'import { createWorkflow, type WorkflowDeferOptions } from "vite-hub/workflow"',
      'import * as queue from "vite-hub/queue"',
      'queue.runQueue("welcome", {})',
      'function custom(queue: { runQueue(): void }) { queue.runQueue() }',
      'const handle = createWorkflow("welcome")',
      'const alias = handle',
      'const second = alias',
      'await second.run()',
      'const run = await alias.defer()',
      'function unrelated(alias: { run(): void }) { alias.run() }',
    ].join("\n"))
    const { result } = await runCodemod("queue-workflow-verbs", { cwd, dryRun: true })
    const output = result.edits[0]!.after
    expect(output).toContain('import { createWorkflow, type WorkflowStartOptions }')
    expect(output).toContain('queue.sendQueue("welcome", {})')
    expect(output).toContain('function custom(queue: { runQueue(): void }) { queue.runQueue() }')
    expect(output).toContain('await second.start()')
    expect(output).toContain('const run = await alias.start()')
    expect(output).toContain('function unrelated(alias: { run(): void }) { alias.run() }')
  })

  it("preserves a local barrel's exports for its consumers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    await cp(join(fixture, "input"), cwd, { recursive: true })
    await runCodemod("queue-workflow-verbs", { cwd })
    const barrel = await readFile(join(cwd, "server/utils/barrel.ts"), "utf8")
    expect(barrel).toContain('export { useQueue as getQueue, sendQueue as runQueue }')
    expect(await readFile(join(cwd, "server/utils/barrel-consumer.ts"), "utf8"))
      .toBe(await readFile(join(fixture, "input/server/utils/barrel-consumer.ts"), "utf8"))
  })

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

  it.each([
    'import { deferWorkflow } from "vite-hub/workflow"; const run = await deferWorkflow("welcome")',
    'import { deferWorkflow } from "@vite-hub/workflow"; await deferWorkflow("welcome")',
    'import { createWorkflow } from "vite-hub/workflow"; const handle = createWorkflow("welcome"); const run = await handle.defer()',
    'import { createWorkflow } from "@vite-hub/workflow"; const handle = createWorkflow("welcome"); await handle.run()',
    'import * as workflow from "vite-hub/workflow"; const run = await workflow.deferWorkflow("welcome")',
    'import { createWorkflow as create } from "vite-hub/workflow"; const handle = create("welcome"); const alias = handle; await alias.run()',
  ])("detects a Workflow contract change without renamed imports: %s", async (source) => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    await writeFile(join(cwd, "workflow.ts"), source)
    const codemod = codemods.find(entry => entry.name === "queue-workflow-verbs")!
    await expect(codemod.detect({ cwd })).resolves.toBeDefined()
    await runCodemod("queue-workflow-verbs", { cwd })
    await expect(codemod.detect({ cwd })).resolves.toBeUndefined()
  })

  it("does not detect unchanged Workflow contracts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    await writeFile(join(cwd, "workflow.ts"), [
      'import { createWorkflow, deferWorkflow } from "vite-hub/workflow"',
      'const handle = createWorkflow("welcome")',
      'await handle.start()',
      'handle.defer()',
      'deferWorkflow("welcome")',
    ].join("\n"))
    const codemod = codemods.find(entry => entry.name === "queue-workflow-verbs")!
    await expect(codemod.detect({ cwd })).resolves.toBeUndefined()
  })

  it("detects an exported Workflow handle that needs a manual consumer migration", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    await writeFile(join(cwd, "workflow.ts"), 'import { createWorkflow } from "vite-hub/workflow"; export const handle = createWorkflow("welcome")')
    await writeFile(join(cwd, "consumer.ts"), 'import { handle } from "./workflow"; await handle.run()')
    const { result } = await runCodemod("queue-workflow-verbs", { cwd, dryRun: true })
    expect(result.edits).toEqual([])
    expect(result.followUps).toEqual([expect.objectContaining({ file: "workflow.ts", message: expect.stringContaining("where other files call it") })])
    const codemod = codemods.find(entry => entry.name === "queue-workflow-verbs")!
    await expect(codemod.detect({ cwd })).resolves.toEqual({ reason: "workflow.ts needs a manual Queue or Workflow migration" })
  })

  it.each(["vite-hub/queue", "@vite-hub/queue", "vite-hub/workflow", "@vite-hub/workflow"])("reports indirect re-exports from %s and detects their consumers' migration", async (module) => {
    const cwd = await mkdtemp(join(tmpdir(), "vitehub-codemod-verbs-"))
    directories.push(cwd)
    const queue = module.endsWith("/queue")
    const oldName = queue ? "runQueue" : "runWorkflow"
    const newName = queue ? "sendQueue" : "startWorkflow"
    const barrel = `export * from "${module}"\nexport * as primitive from "${module}"\n`
    const consumer = `import { ${oldName}, primitive } from "./barrel"; ${oldName}("welcome"); primitive.${oldName}("welcome")`
    await writeFile(join(cwd, "barrel.ts"), barrel)
    await writeFile(join(cwd, "consumer.ts"), consumer)
    const { result } = await runCodemod("queue-workflow-verbs", { cwd, dryRun: true })
    expect(result.edits).toEqual([])
    expect(result.followUps).toEqual([1, 2].map(line => expect.objectContaining({
      file: "barrel.ts", line, message: expect.stringContaining("barrel's consumers"),
    })))
    for (const followUp of result.followUps) expect(followUp.message).toContain(newName)
    expect(await readFile(join(cwd, "barrel.ts"), "utf8")).toBe(barrel)
    expect(await readFile(join(cwd, "consumer.ts"), "utf8")).toBe(consumer)
    const codemod = codemods.find(entry => entry.name === "queue-workflow-verbs")!
    await expect(codemod.detect({ cwd })).resolves.toEqual({ reason: "barrel.ts needs a manual Queue or Workflow migration" })
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
