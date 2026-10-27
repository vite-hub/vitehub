import { createExecutionBudget } from "@vite-hub/runtime"
import { describe, expect, it, vi } from "vitest"

import { createShellRuntime } from "../src/index.ts"
import type { ShellExecutionProvider } from "../src/index.ts"

function createSession(startImplementation?: ShellExecutionProvider["startProcess"]) {
  const startProcess = vi.fn(async (command: string) => ({
    id: command,
    command,
    async stop() { return { event: "command_finished" as const, exitCode: 0, stderr: "", stdout: "" } },
  }))
  const provider: ShellExecutionProvider = {
    boundary: {
      cwd: true,
      env: true,
      filesystem: { writable: false },
      network: false,
      processes: { background: true, interactive: false },
      streaming: false,
      timeout: { enforcedBy: "provider", supported: true },
    },
    async exec() { return { event: "command_finished" as const, exitCode: 0, stderr: "", stdout: "" } },
    startProcess: startImplementation ?? startProcess,
  }
  return { session: createShellRuntime({ provider }).createSession(), startProcess }
}

describe("background process execution budgets", () => {
  it.each([
    { maxToolCalls: 0 },
    { maxInputBytes: 1 },
  ])("rejects a process before provider dispatch when the budget is exhausted: %j", async (limits) => {
    const budget = createExecutionBudget(limits)
    const { session, startProcess } = createSession()
    try {
      await expect(session.startProcess("worker", { budget })).rejects.toThrow("Execution budget exhausted")
      expect(startProcess).not.toHaveBeenCalled()
    }
    finally {
      await session.dispose()
      budget.dispose()
    }
  })

  it.each(["budget", "caller", "budget only"] as const)("aborts pending provider startup on %s cancellation", async (source) => {
    const budget = createExecutionBudget({ maxToolCalls: 1 })
    const caller = new AbortController()
    let providerSignal: AbortSignal | undefined
    let rejectStart!: (reason: unknown) => void
    const { session } = createSession(async (_command, options) => new Promise((_resolve, reject) => {
      rejectStart = reject
      providerSignal = options?.signal
      providerSignal?.addEventListener("abort", () => reject(providerSignal?.reason), { once: true })
    }))
    const pending = session.startProcess("worker", { budget, signal: source === "budget only" ? undefined : caller.signal })
    const reason = new Error("startup cancelled")
    const rejected = expect(pending).rejects.toBe(reason)
    try {
      expect(providerSignal?.aborted).toBe(false)
      const disposed = session.dispose()
      if (source === "caller") caller.abort(reason)
      else budget.cancel(reason)
      expect(providerSignal?.aborted).toBe(true)
      await rejected
      await disposed
      expect(await session.listProcesses()).toEqual([])
      expect(budget.snapshot().usage).toMatchObject({ toolCalls: 1, inputBytes: 6 })
    }
    finally {
      rejectStart(reason)
      await rejected
      await session.dispose()
      budget.dispose()
    }
  })

  it("shares call and UTF-8 input usage with foreground commands", async () => {
    const budget = createExecutionBudget({ maxToolCalls: 2 })
    const { session, startProcess } = createSession()
    try {
      await session.exec("echo ok", { budget })
      await session.startProcess("echo café", { budget })
      expect(budget.snapshot().usage).toMatchObject({ toolCalls: 2, inputBytes: 17 })
      await expect(session.startProcess("worker", { budget })).rejects.toThrow("Execution budget exhausted")
      expect(startProcess).toHaveBeenCalledTimes(1)
    }
    finally {
      await session.dispose()
      budget.dispose()
    }
  })

  it("does not charge a process twice when its caller already charged it", async () => {
    const budget = createExecutionBudget({ maxToolCalls: 1 })
    const { session } = createSession()
    budget.recordToolCall(6)
    try {
      await session.startProcess("worker", { budget, budgetCharged: true })
      expect(budget.snapshot().usage).toMatchObject({ toolCalls: 1, inputBytes: 6 })
    }
    finally {
      await session.dispose()
      budget.dispose()
    }
  })
})
