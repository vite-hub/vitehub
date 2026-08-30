import { describe, expect, it, vi } from "vitest"

import { awaitAgentInvocationResult, createBackedAgentInvocationController } from "../src/agent-invocation.ts"
import { defineAgent, startAgentInvocation, workflow } from "../src/index.ts"
import {
  agentInvocationControlId,
  activeAgentInvocation,
  registerActiveAgentInvocation,
  withAgentInvocationControlId,
} from "../src/internal/agent-invocation-control.ts"

import type { AgentRuntimeContext } from "../src/index.ts"

function runtime(overrides: Partial<AgentRuntimeContext> = {}): AgentRuntimeContext {
  return {
    memo: (_key, create) => create(),
    runtime: "unknown",
    waitUntil: promise => void Promise.resolve(promise).catch(() => {}),
    ...overrides,
  }
}

function backedController(id: string) {
  return createBackedAgentInvocationController({
    cancel: async () => undefined,
    errorOutcome: () => "unavailable",
    id,
    inspect: async () => undefined,
    result: () => Promise.resolve(),
    startResult: Promise.resolve(),
  })
}

describe("Agent Invocation controllers", () => {
  it("isolates active invocation owners by route state", () => {
    const firstState = {}
    const secondState = {}
    const firstController = backedController("first")
    const secondController = backedController("second")
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
    expect(agentInvocationControlId({ run: { runId: "provider-run" } })).toBe("provider-run")
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
    await expect(second.result).resolves.toBe("done")
    await vi.waitFor(async () => {
      await expect(second.inspect()).resolves.toEqual({
        invocation: { id: second.id, output: "done", status: "completed" },
        outcome: "available",
      })
    })
  })

  it("settles inline streams before resolving the public result", async () => {
    const agent = defineAgent({
      driver: {
        async *run() {
          yield "first"
          yield " second"
        },
      },
      runtime: false,
    })

    const controller = await startAgentInvocation(agent, runtime(), {})

    const result = await controller.result
    expect(result).toMatchObject({ text: "first second" })
    expect(Reflect.get(result as object, Symbol.asyncIterator)).toBeUndefined()
    expect(() => structuredClone(result)).not.toThrow()
    await expect(controller.inspect()).resolves.toMatchObject({
      invocation: { status: "completed" },
      outcome: "available",
    })
  })

  it("settles nested inline streams before resolving the public result", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            answer: 42,
            finishReason: "stop",
            fullStream: (async function* () {
              yield { delta: "nested", type: "text-delta" }
            })(),
            raw: { providerData: "preserved" },
            requestId: "request-1",
          }
        },
      },
      runtime: false,
    })

    const controller = await startAgentInvocation(agent, runtime(), {})

    const result = await controller.result
    expect(result).toMatchObject({
      answer: 42,
      finishReason: "stop",
      raw: { providerData: "preserved" },
      requestId: "request-1",
      text: "nested",
    })
    expect(result).not.toHaveProperty("fullStream")
    expect(() => structuredClone(result)).not.toThrow()
    await expect(controller.inspect()).resolves.toMatchObject({
      invocation: { status: "completed" },
      outcome: "available",
    })
  })

  it("settles nested inline streams when the result already contains text", async () => {
    let cleanedUp = false
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            fullStream: (async function* () {
              try {
                yield { delta: "streamed", type: "text-delta" }
              }
              finally {
                cleanedUp = true
              }
            })(),
            text: "existing text",
          }
        },
      },
      runtime: false,
    })

    const result = await (await startAgentInvocation(agent, runtime(), {})).result
    expect(result).toMatchObject({ text: "existing text" })
    expect(result).not.toHaveProperty("fullStream")
    expect(cleanedUp).toBe(true)
  })

  it("removes nested stream surfaces from inferred raw child results", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            answer: 42,
            fullStream: (async function* () {
              yield { delta: "nested", type: "text-delta" }
            })(),
            requestId: "request-1",
          }
        },
      },
      runtime: false,
    })

    const controller = await startAgentInvocation(agent, runtime(), {})

    const result = await controller.result
    expect(result).toMatchObject({
      answer: 42,
      raw: { answer: 42, requestId: "request-1" },
      requestId: "request-1",
      text: "nested",
    })
    expect(result).not.toHaveProperty("fullStream")
    expect((result as { raw: object }).raw).not.toHaveProperty("fullStream")
    expect(() => structuredClone(result)).not.toThrow()
  })

  it("preserves non-stream fields whose names overlap stream surfaces", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            fullStream: (async function* () {
              yield { delta: "nested", type: "text-delta" }
            })(),
            raw: { stream: "upstream" },
            stream: "public metadata",
          }
        },
      },
      runtime: false,
    })

    const result = await (await startAgentInvocation(agent, runtime(), {})).result
    expect(result).toMatchObject({
      raw: { stream: "upstream" },
      stream: "public metadata",
      text: "nested",
    })
    expect(() => structuredClone(result)).not.toThrow()
  })

  it("preserves non-plain cloneable raw child results", async () => {
    const raw = new Map([["providerData", "preserved"]])
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            fullStream: (async function* () {
              yield { delta: "nested", type: "text-delta" }
            })(),
            raw,
          }
        },
      },
      runtime: false,
    })

    const result = await (await startAgentInvocation(agent, runtime(), {})).result
    expect((result as { raw: Map<string, string> }).raw).toEqual(raw)
    expect((result as { raw: unknown }).raw).toBeInstanceOf(Map)
    expect(() => structuredClone(result)).not.toThrow()
  })

  it("omits non-cloneable raw child results", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            fullStream: (async function* () {
              yield { delta: "nested", type: "text-delta" }
            })(),
            raw: { callback: () => undefined },
          }
        },
      },
      runtime: false,
    })

    const result = await (await startAgentInvocation(agent, runtime(), {})).result
    expect(result).not.toHaveProperty("raw")
    expect(() => structuredClone(result)).not.toThrow()
  })

  it("settles inline UI-message streams before resolving the public result", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            toUIMessageStream: () => new ReadableStream({
              start(controller) {
                controller.enqueue({ messageId: "reply", type: "start" })
                controller.enqueue({ id: "reply", type: "text-start" })
                controller.enqueue({ delta: "ui message", id: "reply", type: "text-delta" })
                controller.enqueue({ id: "reply", type: "text-end" })
                controller.enqueue({ finishReason: "stop", type: "finish" })
                controller.close()
              },
            }),
          }
        },
      },
      runtime: false,
    })

    const controller = await startAgentInvocation(agent, runtime(), {})

    const result = await controller.result
    expect(result).toMatchObject({ finishReason: "stop", text: "ui message" })
    expect(result).not.toHaveProperty("toUIMessageStream")
    expect(() => structuredClone(result)).not.toThrow()
    await expect(controller.inspect()).resolves.toMatchObject({
      invocation: { status: "completed" },
      outcome: "available",
    })
  })

  it("preserves cloneable raw data for inline UI-message results", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            raw: { providerData: "preserved" },
            toUIMessageStream: () => new ReadableStream({
              start(controller) {
                controller.enqueue({ messageId: "reply", type: "start" })
                controller.enqueue({ delta: "ui message", id: "reply", type: "text-delta" })
                controller.enqueue({ finishReason: "stop", type: "finish" })
                controller.close()
              },
            }),
          }
        },
      },
      runtime: false,
    })

    const result = await (await startAgentInvocation(agent, runtime(), {})).result
    expect(result).toMatchObject({
      finishReason: "stop",
      raw: { providerData: "preserved" },
      text: "ui message",
    })
    expect(result).not.toHaveProperty("toUIMessageStream")
    expect(() => structuredClone(result)).not.toThrow()
  })

  it("preserves existing text when an inline UI-message stream emits no text", async () => {
    const agent = defineAgent({
      driver: {
        async run() {
          return {
            text: "existing text",
            toUIMessageStream: () => new ReadableStream({
              start(controller) {
                controller.enqueue({ delta: "", id: "reply", type: "text-delta" })
                controller.enqueue({ finishReason: "tool-calls", type: "finish" })
                controller.close()
              },
            }),
          }
        },
      },
      runtime: false,
    })

    const result = await (await startAgentInvocation(agent, runtime(), {})).result
    expect(result).toMatchObject({ finishReason: "tool-calls", text: "existing text" })
    expect(result).not.toHaveProperty("toUIMessageStream")
  })

  it("returns a readable Response after settling the public result", async () => {
    const agent = defineAgent({
      driver: {
        run: () => new Response("settled response", { headers: { "x-result": "preserved" }, status: 202 }),
      },
      runtime: false,
    })

    const controller = await startAgentInvocation(agent, runtime(), {})
    const result = await controller.result

    expect(result).toBeInstanceOf(Response)
    if (!(result instanceof Response)) throw new TypeError("Expected an inline Response result.")
    expect(result.status).toBe(202)
    expect(result.headers.get("x-result")).toBe("preserved")
    await expect(result.text()).resolves.toBe("settled response")
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
    const parent = new AbortController()
    const removeEventListener = vi.spyOn(parent.signal, "removeEventListener")
    const agent = defineAgent({
      driver: { run: ({ run }) => run?.runId },
      runtime: workflow("controlled-child"),
    })
    const controller = await startAgentInvocation(agent, runtime({
      run: { origin: "parent", runId: "parent-run", threadId: "thread-1" },
      runtime: "vercel",
      waitUntil: promise => waitUntilTasks.push(Promise.resolve(promise)),
    }), { abortSignal: parent.signal })

    expect(controller.id).not.toBe("parent-run")
    await expect(controller.inspect()).resolves.toMatchObject({ outcome: "available" })
    await expect(controller.cancel()).resolves.toMatchObject({
      id: controller.id,
      outcome: "unsupported",
    })
    await Promise.all(waitUntilTasks)
    await expect(controller.result).resolves.toBe(controller.id)
    await vi.waitFor(() => expect(removeEventListener).toHaveBeenCalledOnce())
    parent.abort("too late")
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
      result: () => Promise.resolve(),
      startResult: Promise.resolve(),
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
      result: () => Promise.resolve(),
      startResult: Promise.resolve(),
    })

    await expect(controller.inspect()).resolves.toMatchObject({
      invocation: { status: "completed" },
      outcome: "available",
    })
    expect(removeEventListener).toHaveBeenCalledOnce()
    parent.abort("too late")
    expect(cancel).not.toHaveBeenCalled()
  })

  it("stops observing parent cancellation after explicit backed invocation settlement", async () => {
    const parent = new AbortController()
    const removeEventListener = vi.spyOn(parent.signal, "removeEventListener")
    const cancel = vi.fn(async () => ({ id: "child", status: "cancelled" as const }))
    let settle!: () => void
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    createBackedAgentInvocationController({
      cancel,
      errorOutcome: () => "unavailable",
      id: "child",
      inspect: async () => ({ id: "child", status: "running" }),
      parentAbortSignal: parent.signal,
      result: () => Promise.resolve(),
      startResult: Promise.resolve(),
      settled,
    })

    settle()
    await settled
    expect(removeEventListener).toHaveBeenCalledOnce()
    parent.abort("too late")
    expect(cancel).not.toHaveBeenCalled()
  })

  it("stops observing parent cancellation after a backed result settles", async () => {
    const parent = new AbortController()
    const removeEventListener = vi.spyOn(parent.signal, "removeEventListener")
    const cancel = vi.fn(async () => ({ id: "child", status: "cancelled" as const }))
    const controller = createBackedAgentInvocationController({
      cancel,
      errorOutcome: () => "unavailable",
      id: "child",
      inspect: async () => ({ id: "child", status: "running" }),
      parentAbortSignal: parent.signal,
      result: () => Promise.resolve("done"),
      startResult: Promise.resolve(),
    })

    await expect(controller.result).resolves.toBe("done")
    expect(removeEventListener).toHaveBeenCalledOnce()
    parent.abort("too late")
    expect(cancel).not.toHaveBeenCalled()
  })

  it("keeps observing parent cancellation when only a backed start result settles", async () => {
    const parent = new AbortController()
    const cancel = vi.fn(async () => ({ id: "child", status: "cancelled" as const }))
    const controller = createBackedAgentInvocationController({
      cancel,
      errorOutcome: () => "unavailable",
      id: "child",
      inspect: async () => ({ id: "child", status: "running" }),
      parentAbortSignal: parent.signal,
      result: () => new Promise(() => {}),
      startResult: Promise.resolve({ id: "child", status: "queued" }),
    })

    await expect(awaitAgentInvocationResult(controller)).resolves.toEqual({ id: "child", status: "queued" })
    parent.abort("stop queued child")
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it("starts backed result observation only once and only when consumed", async () => {
    const result = vi.fn(async () => { throw new Error("failed") })
    const controller = createBackedAgentInvocationController({
      cancel: async () => undefined,
      errorOutcome: () => "unavailable",
      id: "child",
      inspect: async () => ({ id: "child", status: "running" }),
      result,
      startResult: Promise.resolve(),
    })

    expect(result).not.toHaveBeenCalled()
    const first = controller.result
    expect(controller.result).toBe(first)
    await expect(first).rejects.toThrow("failed")
    expect(result).toHaveBeenCalledOnce()
  })
})
