import { describe, expect, it, vi } from "vitest"

import { createExecutionBudget, ExecutionBudgetExceededError } from "../src/index.ts"

describe("ExecutionBudget", () => {
  describe.each(["root", "child"] as const)("%s deadline before timer delivery", (kind) => {
    it.each(["consume", "recordInputBytes", "recordOutputBytes", "recordRetry", "recordToolCall"] as const)("rejects %s without charging usage", (operation) => {
      vi.useFakeTimers()
      const deadlineAt = Date.now() + 1_000
      const root = createExecutionBudget(kind === "root" ? { deadlineAt } : {})
      const budget = kind === "root" ? root : root.child({ deadlineAt })
      const descendant = budget.child()
      try {
        // Moving the clock does not deliver the pending deadline timer.
        vi.setSystemTime(deadlineAt)
        expect(budget.signal.aborted).toBe(false)
        const charge = () => {
          if (operation === "consume") budget.consume("toolCalls")
          else budget[operation](1)
        }

        expect(charge).toThrow("deadline exceeded")
        expect(budget.signal.reason).toMatchObject({ name: "TimeoutError" })
        expect(descendant.signal.reason).toBe(budget.signal.reason)
        expect(root.snapshot().usage).toEqual({ inputBytes: 0, outputBytes: 0, retries: 0, toolCalls: 0 })
        if (kind === "child") expect(() => root.recordToolCall()).not.toThrow()
      }
      finally {
        root.dispose()
        vi.useRealTimers()
      }
    })
  })

  it("chains long root and child deadlines without timer overflow", () => {
    vi.useFakeTimers()
    try {
      const duration = 2_147_483_647 + 100
      const root = createExecutionBudget({ deadlineAt: Date.now() + duration })
      const child = createExecutionBudget().child({ deadlineAt: Date.now() + duration })
      vi.advanceTimersByTime(2_147_483_647)
      expect(root.signal.aborted).toBe(false)
      expect(child.signal.aborted).toBe(false)
      vi.advanceTimersByTime(100)
      expect(root.signal.aborted).toBe(true)
      expect(child.signal.aborted).toBe(true)
    }
    finally {
      vi.useRealTimers()
    }
  })

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
    expect(budget.snapshot().cancelled).toBe(true)
    expect(() => budget.recordToolCall(7)).toThrow("retries")
    expect(budget.signal.aborted).toBe(true)
    const inputBudget = createExecutionBudget({ maxInputBytes: 6 })
    expect(() => inputBudget.recordToolCall(7)).toThrow("inputBytes")
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])("rejects invalid tool input bytes %s without charging or cancelling", (inputBytes) => {
    const budget = createExecutionBudget({ maxInputBytes: 3, maxToolCalls: 1 })
    try {
      expect(() => budget.recordToolCall(inputBytes)).toThrow(RangeError)
      expect(budget.snapshot().usage).toEqual({ inputBytes: 0, outputBytes: 0, retries: 0, toolCalls: 0 })
      expect(budget.signal.aborted).toBe(false)

      budget.recordToolCall(3)
      expect(budget.snapshot().usage).toMatchObject({ inputBytes: 3, toolCalls: 1 })
    }
    finally {
      budget.dispose()
    }
  })

  it.each([undefined, 0])("allows a tool call with %s input bytes after the parent's byte usage exceeds the child's limit", (inputBytes) => {
    const budget = createExecutionBudget({ maxInputBytes: 3 })
    try {
      budget.recordInputBytes(3)
      const child = budget.child({ maxInputBytes: 0 })
      child.recordToolCall(inputBytes)
      expect(budget.snapshot().usage).toMatchObject({ inputBytes: 3, toolCalls: 1 })
      expect(child.signal.aborted).toBe(false)
    }
    finally {
      budget.dispose()
    }
  })

  it("aborts on byte exhaustion and detaches external cancellation listeners", () => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")
    const budget = createExecutionBudget({ maxOutputBytes: 1, signal: controller.signal })

    expect(() => budget.recordOutputBytes(2)).toThrow(ExecutionBudgetExceededError)
    expect(budget.signal.aborted).toBe(true)
    expect(removeListener).toHaveBeenCalled()
  })

  it.each(["inputBytes", "outputBytes", "retries", "toolCalls"] as const)("aborts concurrent work when public consume exhausts %s without charging the failed attempt", counter => {
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, "removeEventListener")
    const budget = createExecutionBudget({ maxInputBytes: 1, maxOutputBytes: 1, maxRetries: 1, maxToolCalls: 1, signal: controller.signal })
    const child = budget.child()
    budget.consume(counter)
    const usage = budget.snapshot().usage

    expect(() => budget.consume(counter)).toThrow(ExecutionBudgetExceededError)
    expect(budget.signal.aborted).toBe(true)
    expect(budget.signal.reason).toBeInstanceOf(ExecutionBudgetExceededError)
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe(budget.signal.reason)
    expect(budget.snapshot().usage).toEqual(usage)
    expect(removeListener).toHaveBeenCalled()
  })

  it("does not cancel public consume for an invalid amount", () => {
    const budget = createExecutionBudget({ maxInputBytes: 1 })
    expect(() => budget.consume("inputBytes", -1)).toThrow(RangeError)
    expect(budget.signal.aborted).toBe(false)
    expect(budget.snapshot().usage.inputBytes).toBe(0)
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

  it.each(["cancel", "external signal"])("propagates parent %s to existing and new descendants only", source => {
    const external = new AbortController()
    const root = createExecutionBudget()
    const parent = root.child({ signal: external.signal })
    const sibling = root.child()
    const grandchild = parent.child()
    const descendant = grandchild.child()
    const reason = new Error("stop this subtree")

    try {
      if (source === "cancel") parent.cancel(reason)
      else external.abort(reason)

      for (const budget of [parent, grandchild, descendant, parent.child(), grandchild.child()]) {
        expect(budget.signal.aborted).toBe(true)
        expect(budget.signal.reason).toBe(reason)
        expect(budget.snapshot().cancelled).toBe(true)
        expect(() => budget.recordToolCall()).toThrow(reason)
      }
      expect(root.snapshot().usage.toolCalls).toBe(0)
      for (const budget of [root, sibling]) {
        expect(budget.signal.aborted).toBe(false)
        expect(() => budget.recordToolCall()).not.toThrow()
      }
      expect(root.snapshot().usage.toolCalls).toBe(2)
    }
    finally {
      root.dispose()
    }
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

  it("disposes deadline timers and external abort listeners, including child budgets", () => {
    vi.useFakeTimers()
    try {
      const external = new AbortController()
      const budget = createExecutionBudget({ signal: external.signal, deadlineAt: Date.now() + 1_000 })
      const child = budget.child({ signal: external.signal, deadlineAt: Date.now() + 2_000 })

      expect(vi.getTimerCount()).toBe(2)
      budget.dispose()
      budget.dispose()
      expect(vi.getTimerCount()).toBe(0)

      external.abort(new Error("late cancellation"))
      vi.setSystemTime(Date.now() + 3_000)
      expect(budget.signal.aborted).toBe(false)
      expect(child.signal.aborted).toBe(false)
      expect(() => budget.recordToolCall()).not.toThrow()
      expect(() => child.recordToolCall()).not.toThrow()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it("does not reacquire resources when a child is created after disposal", () => {
    vi.useFakeTimers()
    try {
      const external = new AbortController()
      const budget = createExecutionBudget({ signal: external.signal })
      budget.dispose()

      const child = budget.child({ signal: external.signal, deadlineAt: Date.now() + 1_000 })
      expect(vi.getTimerCount()).toBe(0)
      expect(child.signal.aborted).toBe(false)

      external.abort(new Error("late cancellation"))
      expect(child.signal.aborted).toBe(false)
      expect(() => child.recordToolCall()).not.toThrow()
    }
    finally {
      vi.useRealTimers()
    }
  })
})
