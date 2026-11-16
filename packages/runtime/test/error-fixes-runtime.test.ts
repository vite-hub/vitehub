import { expect, it } from "vitest"

import { runtimeErrorDiagnostics } from "../src/error-diagnostics.ts"
import { normalizeRuntimeDiagnosticError } from "../src/index.ts"
import { createProcessReconciler } from "../src/internal/node.ts"

const fixedCodes = [
  "RUNTIME_R0001",
  "RUNTIME_R0002",
  "RUNTIME_R0003",
  "RUNTIME_R0004",
  "RUNTIME_R0005",
  "RUNTIME_R0006",
  "RUNTIME_R0007",
  "RUNTIME_R0009",
  "RUNTIME_R0010",
  "RUNTIME_R0011",
  "RUNTIME_R0015",
  "RUNTIME_R0016",
] as const

it("gives each Runtime code a fix and its own docs page", () => {
  for (const code of fixedCodes) {
    const error = runtimeErrorDiagnostics[code]({ message: "m" })
    expect(error.fix, code).toMatch(/\S/)
    expect(error.docs, code).toBe(`https://vitehub.dev/docs/development/diagnostics/${code.toLowerCase()}`)
  }
})

it("tells the developer which maxDepth normalizeRuntimeDiagnosticError() takes", () => {
  expect(() => normalizeRuntimeDiagnosticError(new Error("boom"), { maxDepth: -1 })).toThrow(expect.objectContaining({
    code: "RUNTIME_R0001",
    fix: expect.stringContaining("`maxDepth`"),
  }))
})

it("tells the developer which intervalMs the process reconciler takes", () => {
  expect(() => createProcessReconciler({ intervalMs: 0, run: async () => {} })).toThrow(expect.objectContaining({
    code: "RUNTIME_R0009",
    fix: expect.stringContaining("`intervalMs`"),
  }))
})
