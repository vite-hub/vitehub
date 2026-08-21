import { describe, expect, it, vi } from "vitest"

import { createBackedAgentInvocationController } from "../src/agent-invocation.ts"
import { subagents } from "../src/capabilities.ts"
import { defineAgent, startAgentInvocation, workflow } from "../src/index.ts"
import {
  agentInvocationControlId,
  activeAgentInvocation,
  registerActiveAgentInvocation,
  withAgentInvocationControlId,
} from "../src/internal/agent-invocation-control.ts"

import type { AgentRuntimeContext, AgentToolDefinition } from "../src/index.ts"

function runtime(overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
    ...overrides,
  }
}

describe("Agent Invocation controllers", () => {
  it("isolates active invocation owners by route state", () => {
    const firstState = {}
    const secondState = {}
    const firstController = { id: "first" } as never
    const secondController = { id: "second" } as never
    const unregisterFirst = registerActiveAgentInvocation("shared-key", firstController, Promise.resolve(), firstState)
    const unregisterSecond = registerActiveAgentInvocation("shared-key", secondController, Promise.resolve(), secondState)

    expect(activeAgentInvocation("shared-key", firstState)?.controller).toBe(firstController)
    expect(activeAgentInvocation("shared-key", secondState)?.controller).toBe(secondController)
    expect(activeAgentInvocation("shared-key")).toBeUndefined()
    unregisterFirst()
    unregisterSecond()
  })

  it("keeps controller identity separate from provider run metadata", () => {
    const first = withAgentInvocationControlId({ run: { runId: "shared-provider-run" } }, "ainv_first")
    const second = withAgentInvocationControlId({ run: { runId: "shared-provider-run" } }, "ainv_second")

    expect(agentInvocationControlId(first)).toBe("ainv_first")
    expect(agentInvocationControlId(second)).toBe("ainv_second")
    expect(first.run.runId).toBe(second.run.runId)
    expect(agentInvocationControlId({ run: { runId: "legacy-run" } })).toBe("legacy-run")
  })

  it("starts fresh inline invocations and inspects their authoritative lifecycle", async () => {
    const completions: Array<(value: string) => void> = []
    const agent = defineAgent({
      driver: {
        run: () => new Promise<string>((resolve) => {
          completions.push(resolve)
        }),
      },
      runtime: false,
    })

    const first = await startAgentInvocation(agent, runtime({ run: { runId: "parent" } }), {})
    const second = await startAgentInvocation(agent, runtime({ run: { runId: "parent" } }), {})

    expect(first.id).toMatch(/^ainv_/)
    expect(second.id).toMatch(/^ainv_/)
    expect(second.id).not.toBe(first.id)
    await expect(first.inspect()).resolves.toEqual({
      invocation: { id: first.id, status: "running" },
      outcome: "available",
    })

    await vi.waitFor(() => expect(completions).toHaveLength(2))
    completions[1]!("done")
    await vi.waitFor(async () => {
      await expect(second.inspect()).resolves.toEqual({
        invocation: { id: second.id, output: "done", status: "completed" },
        outcome: "available",
      })
    })
  })

  it("propagates controller and parent cancellation without claiming synchronous termination", async () => {
    const agent = defineAgent({
      driver: {
        run: ({ input }) => new Promise((_resolve, reject) => {
          if (input.abortSignal?.aborted) reject(input.abortSignal.reason)
          else input.abortSignal?.addEventListener("abort", () => reject(input.abortSignal?.reason), { once: true })
        }),
      },
      runtime: false,
    })
    const parent = new AbortController()
    const controlled = await startAgentInvocation(agent, runtime(), {})
    const inherited = await startAgentInvocation(agent, runtime(), { abortSignal: parent.signal })

    await expect(controlled.cancel("stop")).resolves.toMatchObject({
      id: controlled.id,
      outcome: "accepted",
    })
    parent.abort("parent stopped")

    await vi.waitFor(async () => {
      await expect(controlled.inspect()).resolves.toMatchObject({
        invocation: { status: "cancelled" },
        outcome: "available",
      })
      await expect(inherited.inspect()).resolves.toMatchObject({
        invocation: { status: "cancelled" },
        outcome: "available",
      })
    })
    await expect(controlled.cancel()).resolves.toMatchObject({ outcome: "invalid-state" })
  })

  it("reports follow-up and steering as unsupported without simulating input", async () => {
    const agent = defineAgent({ driver: { run: () => "done" }, runtime: false })
    const controller = await startAgentInvocation(agent, runtime(), {})

    expect(controller.support).toEqual({ followUp: false, respond: false, steer: false })
    await expect(controller.sendInput({ prompt: "continue" }, { mode: "follow-up" })).resolves.toMatchObject({
      id: controller.id,
      outcome: "unsupported",
    })
    await expect(controller.sendInput({ prompt: "change course" }, { mode: "steer" })).resolves.toMatchObject({
      id: controller.id,
      outcome: "unsupported",
    })
    await expect(controller.sendInput({ messages: [] }, { mode: "respond" })).resolves.toMatchObject({
      id: controller.id,
      outcome: "unsupported",
    })
  })

  it("maps Workflow-backed identity and lifecycle without promising cancellation support", async () => {
    const waitUntilTasks: Array<Promise<unknown>> = []
    const agent = defineAgent({
      driver: { run: ({ run }) => run?.runId },
      runtime: workflow("controlled-child"),
    })
    const controller = await startAgentInvocation(agent, runtime({
      run: { origin: "parent", runId: "parent-run", threadId: "thread-1" },
      runtime: "vercel",
      waitUntil: promise => waitUntilTasks.push(Promise.resolve(promise)),
    }), {})

    expect(controller.id).not.toBe("parent-run")
    await expect(controller.inspect()).resolves.toMatchObject({ outcome: "available" })
    await expect(controller.cancel()).resolves.toMatchObject({
      id: controller.id,
      outcome: "unsupported",
    })
    await Promise.all(waitUntilTasks)
    await expect(controller.inspect()).resolves.toEqual({
      invocation: { id: controller.id, output: controller.id, status: "completed" },
      outcome: "available",
    })
  })

  it("attempts backed cancellation independently of inspection availability", async () => {
    const cancel = vi.fn(async () => ({ id: "child", status: "cancelled" as const }))
    const controller = createBackedAgentInvocationController({
      cancel,
      errorOutcome: () => "unavailable",
      id: "child",
      inspect: async () => { throw new Error("inspection unavailable") },
      result: Promise.resolve(),
    })

    await expect(controller.cancel()).resolves.toEqual({
      id: "child",
      invocation: { id: "child", status: "cancelled" },
      outcome: "accepted",
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("stops observing parent cancellation after a backed invocation reaches a terminal state", async () => {
    const parent = new AbortController()
    const removeEventListener = vi.spyOn(parent.signal, "removeEventListener")
    const cancel = vi.fn(async () => ({ id: "child", status: "cancelled" as const }))
    const controller = createBackedAgentInvocationController({
      cancel,
      errorOutcome: () => "unavailable",
      id: "child",
      inspect: async () => ({ id: "child", status: "completed" }),
      parentAbortSignal: parent.signal,
      result: Promise.resolve(),
    })

    await expect(controller.inspect()).resolves.toMatchObject({
      invocation: { status: "completed" },
      outcome: "available",
    })
    expect(removeEventListener).toHaveBeenCalledOnce()
    parent.abort("too late")
    expect(cancel).not.toHaveBeenCalled()
  })

  it("keeps subagents serializable while assigning fresh trusted identities", async () => {
    const child = defineAgent({ driver: { run: ({ run }) => run?.runId }, runtime: false })
    const parent = defineAgent({
      capabilities: [subagents({
        agents: {
          researcher: { agent: child, description: "Research one question." },
        },
      })],
      driver: { model: {} as never },
    })
    const resolved = await parent.resolve(runtime()) as unknown as {
      tools: Record<string, AgentToolDefinition>
    }
    const tool = resolved.tools.run_researcher!
    const first = await tool.execute?.({ message: "one" })
    const second = await tool.execute?.({ message: "two" })

    expect(first).toMatch(/^ainv_/)
    expect(second).toMatch(/^ainv_/)
    expect(second).not.toBe(first)
    expect((tool.inputSchema as { properties?: Record<string, unknown> }).properties).not.toHaveProperty("runId")
  })
})
