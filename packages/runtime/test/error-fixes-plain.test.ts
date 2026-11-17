import { expect, it } from "vitest"

import { runtimeErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createExecutionBudget } from "../src/execution-budget.ts"
import { hostedConsoleUrl } from "../src/hosted-console.ts"
import { deserializeResponse } from "../src/response.ts"

it("gives RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID a fix and its own docs page", () => {
  const error = runtimeErrorDiagnostics.RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID()
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe("https://vitehub.dev/docs/runtime/diagnostics/runtime_execution_budget_limit_invalid")
})

it("reports a negative execution budget limit with its code and fix", () => {
  expect(() => createExecutionBudget({ maxToolCalls: -1 })).toThrow(expect.objectContaining({
    code: "RUNTIME_EXECUTION_BUDGET_LIMIT_INVALID",
    fix: expect.stringContaining("maxToolCalls"),
    message: "[vitehub] Execution budget limits must be finite non-negative numbers.",
  }))
})

it.each(["RUNTIME_CONSOLE_PATH_INVALID", "RUNTIME_CONSOLE_PROJECT_URL_INVALID", "RUNTIME_EXECUTION_BUDGET_AMOUNT_INVALID", "RUNTIME_SERIALIZED_RESPONSE_INVALID"] as const)("gives %s a fix and its own docs page", (code) => {
  const error = runtimeErrorDiagnostics[code]({ counter: "inputBytes", value: "x" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/runtime/diagnostics/${code.toLowerCase()}`)
})

it("reports a bad hostedConsoleUrl() argument, a bad budget amount, and a bad response record with a code and fix", () => {
  expect(() => hostedConsoleUrl("http://app.example.com", "/kv")).toThrow(expect.objectContaining({
    code: "RUNTIME_CONSOLE_PROJECT_URL_INVALID",
    fix: expect.stringContaining("hostedConsoleUrl()"),
    message: expect.stringContaining("http://app.example.com is not a project URL"),
  }))
  expect(() => hostedConsoleUrl("https://app.example.com", "kv")).toThrow(expect.objectContaining({
    code: "RUNTIME_CONSOLE_PATH_INVALID",
    fix: expect.stringContaining("/agents/<agent>/invocations/<id>"),
  }))
  expect(() => createExecutionBudget().consume("toolCalls", Number.NaN)).toThrow(expect.objectContaining({
    code: "RUNTIME_EXECUTION_BUDGET_AMOUNT_INVALID",
    fix: expect.stringContaining("consume()"),
    message: "[vitehub] Execution budget toolCalls amount must be a finite non-negative number.",
  }))
  expect(() => deserializeResponse({} as never)).toThrow(expect.objectContaining({
    code: "RUNTIME_SERIALIZED_RESPONSE_INVALID",
    fix: expect.stringContaining("serializeResponse()"),
  }))
})
