import { expect, it } from "vitest"

import { createExecutionBudget, isExecutionBudgetExceededError } from "../src/index.ts"

it("throws RUNTIME_EXECUTION_BUDGET_EXCEEDED with the counter, the limit, and a fix", () => {
  const budget = createExecutionBudget({ maxToolCalls: 1 })
  budget.recordToolCall()
  const error = (() => {
    try { budget.recordToolCall() }
    catch (caught) { return caught }
  })()
  expect(isExecutionBudgetExceededError(error)).toBe(true)
  expect(error).toMatchObject({
    code: "RUNTIME_EXECUTION_BUDGET_EXCEEDED",
    counter: "toolCalls",
    docs: "https://vitehub.dev/docs/development/diagnostics/runtime_execution_budget_exceeded",
    fix: expect.stringContaining("maxToolCalls"),
    limit: 1,
  })
})
