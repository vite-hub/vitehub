import { describe, expect, it } from "vitest"

import { sandboxTaskErrorDiagnostics } from "../../src/task/error-diagnostics.ts"
import { defineSandboxTask, resolveSandboxTaskRunner } from "../../src/task/index.ts"

const fixedCodes = [
  ...[1, 2, 3, 4, 6, 7, 8].map(code),
  ...range(9, 13),
  ...range(15, 39),
  ...range(41, 42),
  ...range(45, 46),
  ...range(52, 76),
] as const

function code(value: number) {
  return `SANDBOX_TASK_R${String(value).padStart(4, "0")}`
}

function range(from: number, to: number) {
  return Array.from({ length: to - from + 1 }, (_, index) => code(from + index))
}

describe("Sandbox Task runtime error fixes", () => {
  it("gives each fixed Sandbox Task runtime code a fix and its own docs page", () => {
    expect(fixedCodes).toHaveLength(66)
    for (const fixedCode of fixedCodes) {
      const error = sandboxTaskErrorDiagnostics[fixedCode as keyof typeof sandboxTaskErrorDiagnostics]({ message: "m" })
      expect(error.fix, fixedCode).toMatch(/\S/)
      expect(error.docs, fixedCode).toBe(`https://vitehub.dev/docs/sandbox/diagnostics/${fixedCode.toLowerCase()}`)
    }
  })

  it("asks for the Sandbox Task name", async () => {
    await expect(resolveSandboxTaskRunner()).rejects.toMatchObject({
      code: "SANDBOX_TASK_R0052",
      fix: expect.stringContaining("`resolveSandboxTaskRunner(\"release-notes\")`"),
    })
  })

  it("asks for a boolean project option", () => {
    expect(() => defineSandboxTask({ handler: () => "ok", project: "yes" } as never)).toThrow(expect.objectContaining({
      code: "SANDBOX_TASK_R0073",
      fix: expect.stringContaining("`project` of `defineSandboxTask()`"),
    }))
  })

  it("asks for an options object", () => {
    expect(() => defineSandboxTask(undefined as never)).toThrow(expect.objectContaining({
      code: "SANDBOX_TASK_R0072",
      fix: expect.stringContaining("`defineSandboxTask({ handler })`"),
    }))
  })
})
