import { expect, it } from "vitest"

import { runtimeErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createExecutionBudget } from "../src/execution-budget.ts"

it("gives RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID a fix and its own docs page", () => {
  const error = runtimeErrorDiagnostics.RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID()
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe("https://vitehub.dev/docs/development/diagnostics/runtime_execution_budget_limit_invalid")
})

it("reports a negative execution budget limit with its code and fix", () => {
  expect(() => createExecutionBudget({ maxToolCalls: -1 })).toThrow(expect.objectContaining({
    code: "RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID",
    fix: expect.stringContaining("maxToolCalls"),
    message: "[vitehub] Execution budget limits must be finite non-negative numbers.",
  }))
})
