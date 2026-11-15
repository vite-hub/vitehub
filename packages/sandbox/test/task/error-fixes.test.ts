import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, it, onTestFinished } from "vitest"

import { extractSandboxTaskDefinitionMetadata } from "../../src/task/definition-options.ts"
import { sandboxTaskErrorDiagnostics } from "../../src/task/error-diagnostics.ts"
import { defineSandboxTask } from "../../src/task/runtime/registry.ts"

const fixedCodes = [
  "SANDBOX_TASK_C0001",
  "SANDBOX_TASK_C0002",
  "SANDBOX_TASK_C0003",
  "SANDBOX_TASK_C0004",
  "SANDBOX_TASK_C0005",
  "SANDBOX_TASK_C0006",
  "SANDBOX_TASK_C0007",
  "SANDBOX_TASK_C0008",
  "SANDBOX_TASK_C0009",
  "SANDBOX_TASK_C0010",
  "SANDBOX_TASK_C0011",
  "SANDBOX_TASK_C0012",
  "SANDBOX_TASK_C0013",
] as const

async function definitionFile(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-sandbox-task-error-fixes-"))
  onTestFinished(() => rm(directory, { force: true, recursive: true }))
  const file = join(directory, "task.ts")
  await writeFile(file, source)
  return file
}

it("gives each Sandbox Task definition code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = sandboxTaskErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/sandbox/diagnostics/${code.toLowerCase()}`)
  }
})

it("lists the accepted options in the fix of an unknown option", () => {
  expect(() => defineSandboxTask({ handler: async () => {}, retries: 3 } as never)).toThrow(expect.objectContaining({
    code: "SANDBOX_TASK_C0012",
    fix: expect.stringContaining("`handler`, `timeout`, `env`, and `project`"),
    message: "[vitehub] `defineSandboxTask()` supports only portable Sandbox options (handler, timeout, env, project). Unsupported keys: retries.",
  }))
})

it("names handler in the fix of a missing handler function", () => {
  expect(() => defineSandboxTask({ handler: "run" } as never)).toThrow(expect.objectContaining({
    code: "SANDBOX_TASK_C0010",
    fix: expect.stringContaining("`handler`"),
  }))
})

it("names project in the fix of a project option that the build cannot read", async () => {
  const file = await definitionFile("import { defineSandboxTask } from '@vite-hub/sandbox/task'\nexport default defineSandboxTask({ project: 'yes', handler: async () => {} })\n")
  await expect(extractSandboxTaskDefinitionMetadata(file)).rejects.toMatchObject({
    code: "SANDBOX_TASK_C0008",
    fix: expect.stringContaining("`project`"),
  })
})
