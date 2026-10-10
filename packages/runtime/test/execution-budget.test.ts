import { describe, expect, it } from "vitest"

import { createExecutionBudget, ExecutionBudgetExceededError } from "../src/index.ts"

describe("ExecutionBudget", () => {
  it("tracks bounded tool, byte, and retry usage", () => {
    const budget = createExecutionBudget({ maxInputBytes: 10, maxOutputBytes: 12, maxRetries: 1, maxToolCalls: 2 })
    budget.recordToolCall(4)
    budget.recordOutputBytes(5)
    budget.recordRetry()

    expect(budget.snapshot()).toMatchObject({
      remaining: { inputBytes: 6, outputBytes: 7, retries: 0, toolCalls: 1 },
      usage: { inputBytes: 4, outputBytes: 5, retries: 1, toolCalls: 1 },
    })
    expect(() => budget.recordRetry()).toThrow(ExecutionBudgetExceededError)
    expect(() => budget.recordToolCall(7)).toThrow("inputBytes")
  })

  it("derives a stricter child while sharing parent usage and cancellation", () => {
    const controller = new AbortController()
    const budget = createExecutionBudget({ maxToolCalls: 4, signal: controller.signal })
    const child = budget.child({ maxToolCalls: 1 })

    child.recordToolCall()
    expect(child.snapshot().remaining.toolCalls).toBe(0)
    expect(budget.snapshot().usage.toolCalls).toBe(1)
    expect(() => child.recordToolCall()).toThrow(ExecutionBudgetExceededError)

    controller.abort(new Error("cancelled"))
    expect(child.snapshot().cancelled).toBe(true)
    expect(() => budget.recordToolCall()).toThrow("cancelled")
  })

  it("keeps failed compound usage atomic and honors child signals and deadlines", async () => {
    const budget = createExecutionBudget({ maxInputBytes: 3, maxToolCalls: 2 })
    expect(() => budget.recordToolCall(4)).toThrow(ExecutionBudgetExceededError)
    expect(budget.snapshot().usage).toEqual({ inputBytes: 0, outputBytes: 0, retries: 0, toolCalls: 0 })

    const signal = AbortSignal.timeout(5)
    const child = budget.child({ signal, deadlineAt: Date.now() + 50 })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(child.signal.aborted).toBe(true)
  })

  it("aborts at its deadline and exposes enforcement state", async () => {
    const budget = createExecutionBudget({ deadlineAt: Date.now() + 5 })
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(budget.signal.aborted).toBe(true)
    expect(budget.snapshot().remaining.timeMs).toBe(0)
  })
})
