import { afterEach, describe, expect, it, vi } from "vitest"

const modelGenerate = vi.hoisted(() => vi.fn())
const modelStream = vi.hoisted(() => vi.fn())

vi.mock("../src/internal/ai-sdk-runtime.ts", () => ({
  loadAiSdk: async () => ({
    ToolLoopAgent: class {
      async generate(...args: unknown[]) {
        return await modelGenerate(...args)
      }

      async stream(...args: unknown[]) {
        return await modelStream(...args)
      }
    },
    isStepCount: () => () => false,
    jsonSchema: (schema: unknown) => schema,
  }),
}))

type DriverKind = "model" | "run"
type InvocationForm = "run" | "stream"
type LifecycleScenario = {
  close?: () => void | Promise<void>
  execute?: (events: string[]) => unknown
  finish?: () => void | Promise<void>
  input?: (events: string[]) => Response
}

const driverKinds = ["run", "model"] as const

function createInvocationRuntime() {
  return {
    memo: vi.fn(),
    runtime: "unknown" as const,
    waitUntil: vi.fn(),
  }
}

function createInvocationDriverFixture(
  kind: DriverKind,
  form: InvocationForm,
) {
  const execute = vi.fn()
  if (kind === "run") return { driver: { run: execute }, execute }
  if (kind === "model") {
    const method = form === "run" ? modelGenerate : modelStream
    method.mockImplementationOnce(execute)
    return {
      // SAFETY: The mocked model is never called directly; the hoisted method handles execution.
      driver: { execution: { workspaceFallback: false }, model: {} as never },
      execute,
    }
  }
  return { driver: { run: execute }, execute }
}

async function createLifecycleProbe(
  kind: DriverKind,
  form: InvocationForm,
  scenario: LifecycleScenario,
) {
  const { defineAgent, defineCapability } = await import("../src/index.ts")
  const events: string[] = []
  const driver = createInvocationDriverFixture(kind, form)
  const close = vi.fn(() => {
    events.push("close")
    return scenario.close?.()
  })
  let hookError: unknown
  const error = vi.fn((event) => {
    hookError = event.error
    events.push("error")
    return scenario.finish?.()
  })
  const finish = vi.fn(() => {
    events.push("finish")
    return scenario.finish?.()
  })
  driver.execute.mockImplementation(() => scenario.execute?.(events))
  const agent = defineAgent({
    capabilities: [defineCapability({
      close,
      id: "lifecycle",
      ...(scenario.input ? { input: () => scenario.input!(events) } : {}),
    })],
    // SAFETY: The fixture constructs only the two normalized driver forms exercised below.
    driver: driver.driver as never,
    hooks: {
      "agent:error": error,
      "agent:finish": finish,
    },
  })

  return {
    agent,
    execute: driver.execute,
    get hookError() {
      return hookError
    },
    expectCloseFailed(expectedEvents: string[]) {
      expect(events).toEqual(expectedEvents)
      expect(close).toHaveBeenCalledOnce()
      expect(error).not.toHaveBeenCalled()
      expect(finish).not.toHaveBeenCalled()
    },
    expectFinished(expectedEvents: string[]) {
      expect(events).toEqual(expectedEvents)
      expect(close).toHaveBeenCalledOnce()
      expect(error.mock.calls.length + finish.mock.calls.length).toBe(1)
    },
    expectPending(expectedEvents: string[]) {
      expect(events).toEqual(expectedEvents)
      expect(close).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(finish).not.toHaveBeenCalled()
    },
  }
}

afterEach(() => {
  modelGenerate.mockReset()
  modelStream.mockReset()
})

describe("Agent Invocation Interface lifecycle", () => {
  it.each(driverKinds)("closes %s capabilities before successful finish exactly once", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        return { finishReason: "stop", text: "ok" }
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).resolves.toMatchObject({ text: "ok" })
    probe.expectFinished(["driver", "close", "finish"])
  })

  it.each(driverKinds)("closes %s capabilities before Agent Error Hooks exactly once", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const failure = new Error(`${kind} failed`)
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        throw failure
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).rejects.toBe(failure)
    probe.expectFinished(["driver", "close", "error"])
    expect(probe.hookError).toBe(failure)
  })

  it.each(driverKinds)("preserves the %s finish failure identity after successful execution", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const finishFailure = new Error(`${kind} finish failed`)
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        return { finishReason: "stop", text: "ok" }
      },
      finish() {
        throw finishFailure
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).rejects.toBe(finishFailure)
    probe.expectFinished(["driver", "close", "finish"])
  })

  it.each(driverKinds)("orders the %s execution and finish failures without losing identity", async (kind) => {
    const { runAgent } = await import("../src/index.ts")
    const executionFailure = new Error(`${kind} execution failed`)
    const finishFailure = new Error(`${kind} finish failed`)
    const probe = await createLifecycleProbe(kind, "run", {
      execute(events) {
        events.push("driver")
        throw executionFailure
      },
      finish() {
        throw finishFailure
      },
    })

    // SAFETY: This scenario makes execution and lifecycle finish fail, producing AggregateError.
    const error = await runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" }).catch(error => error) as AggregateError
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toBe("[vitehub] Agent run failed and finish lifecycle also failed.")
    expect(error.errors).toEqual([executionFailure, finishFailure])
    probe.expectFinished(["driver", "close", "error"])
    expect(probe.hookError).toBe(executionFailure)
  })

  it("preserves a close failure instead of aggregating it with itself", async () => {
    const { runAgent } = await import("../src/index.ts")
    const closeFailure = new Error("close failed")
    const probe = await createLifecycleProbe("run", "run", {
      close() {
        throw closeFailure
      },
      execute(events) {
        events.push("driver")
        return "ok"
      },
    })

    await expect(runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })).rejects.toBe(closeFailure)
    probe.expectCloseFailed(["driver", "close"])
  })

  it.each(driverKinds)("defers %s stream cleanup and finish until early termination", async (kind) => {
    const { streamAgent } = await import("../src/index.ts")
    const probe = await createLifecycleProbe(kind, "stream", {
      execute(events) {
        events.push("driver")
        return {
          fullStream: (async function* () {
            try {
              yield { text: "ok", type: "text-delta" }
            }
            finally {
              events.push("stream:return")
            }
          })(),
        }
      },
    })

    // SAFETY: The fixture returns fullStream, so streamAgent exposes an async iterable.
    const stream = await streamAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    probe.expectPending(["driver"])

    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { text: "ok", type: "text-delta" },
    })
    probe.expectPending(["driver"])
    await iterator.return?.()

    probe.expectFinished(["driver", "stream:return", "close", "finish"])
  })

  it("finishes immutable raw streams with their consumed text and usage", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = (async function* () {
      yield { text: "Final ", type: "text-delta" }
      yield { text: "answer.", type: "text-delta" }
      yield { type: "usage", usageRecord: { usage: { totalTokens: 3 } } }
    })()
    Object.preventExtensions(raw)
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({
      invocation: { resultKind: "stream" },
      result: {
        raw,
        text: "Final answer.",
        usage: { totalTokens: 3 },
        usageRecord: { usage: { totalTokens: 3 } },
      },
      text: "Final answer.",
    })
  })

  it("wraps raw streams when their text property cannot be replaced", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = (async function* () {
      yield { text: "Final answer.", type: "text-delta" }
    })()
    Object.defineProperty(raw, "text", {
      configurable: false,
      enumerable: true,
      value: "",
    })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { raw, text: "Final answer." },
      text: "Final answer.",
    })
    expect(raw).toHaveProperty("text", "")
  })

  it("finishes usage-only immutable raw streams without mutating them", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = (async function* () {
      yield { type: "usage", usageRecord: { usage: { totalTokens: 3 } } }
    })()
    Object.preventExtensions(raw)
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        raw,
        usage: { totalTokens: 3 },
        usageRecord: { usage: { totalTokens: 3 } },
      },
    })
    expect(finish.mock.calls[0]![0]).not.toHaveProperty("text")
    expect(Object.isExtensible(raw)).toBe(false)
    expect(raw).not.toHaveProperty("usage")
    expect(raw).not.toHaveProperty("usageRecord")
  })

  it("preserves existing usage on immutable raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    const usageRecord = { cost: { total: 0.01 }, usage }
    const raw = Object.assign((async function* () {
      yield { type: "usage", usageRecord: { model: "provider/model" } }
    })(), { usage, usageRecord })
    Object.preventExtensions(raw)
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        raw,
        usage,
        usageRecord: { ...usageRecord, model: "provider/model" },
      },
    })
  })

  it("preserves promise-backed usage on raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = Promise.resolve({ inputTokens: 2, totalTokens: 2 })
    const raw = Object.assign((async function* () {
      yield { text: "answer", type: "text-delta" }
    })(), { usage })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { raw, text: "answer", usage },
    })
    expect(finish.mock.calls[0]![0].result.usage).toBe(usage)
  })

  it("merges nested usage on immutable raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {
      yield {
        type: "usage",
        usageRecord: {
          model: "provider/model",
          usage: {
            details: { streamed: 4 },
            inputTokenDetails: { cacheWriteTokens: 3 },
            outputTokenDetails: { reasoningTokens: 2 },
            outputTokens: 3,
            totalTokens: 5,
          },
        },
      }
    })(), {
      usageRecord: {
        usage: {
          details: { existing: 1 },
          inputTokenDetails: { cachedTokens: 2 },
          inputTokens: 2,
          outputTokenDetails: { textTokens: 1 },
        },
      },
    })
    Object.preventExtensions(raw)
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    const usage = {
      details: { existing: 1, streamed: 4 },
      inputTokenDetails: { cachedTokens: 2, cacheWriteTokens: 3 },
      inputTokens: 2,
      outputTokenDetails: { reasoningTokens: 2, textTokens: 1 },
      outputTokens: 3,
      totalTokens: 5,
    }
    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        raw,
        usage,
        usageRecord: { model: "provider/model", usage },
      },
    })
  })

  it("preserves immutable plain raw streams in the finish result", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.freeze({
      artifacts: [{ path: "artifacts/answer.txt", url: "https://example.com/answer.txt" }],
      finishReason: "stop",
      warnings: [{ message: "provider warning" }],
      async *[Symbol.asyncIterator]() {
        yield { text: "answer", type: "text-delta" }
        yield { type: "usage", usageRecord: { usage: { totalTokens: 2 } } }
      },
    })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        artifacts: [{ path: "artifacts/answer.txt", url: "https://example.com/answer.txt" }],
        finishReason: "stop",
        raw,
        text: "answer",
        usage: { totalTokens: 2 },
        warnings: [{ message: "provider warning" }],
      },
    })
  })

  it("preserves inherited metadata on immutable raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class RawStream {
      get finishReason() {
        return "stop"
      }

      get warnings() {
        return [{ message: "provider warning" }]
      }

      get text() {
        return "provider answer"
      }

      async *[Symbol.asyncIterator]() {
        yield { type: "usage", usageRecord: { usage: { totalTokens: 2 } } }
      }
    }
    const raw = Object.preventExtensions(new RawStream())
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: RawStream implements the async iterable returned unchanged by the driver.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        finishReason: "stop",
        raw,
        text: "provider answer",
        usage: { totalTokens: 2 },
        warnings: [{ message: "provider warning" }],
      },
    })
  })

  it("keeps collected finish data local when a raw stream is reused", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    let invocation = 0
    const raw = {
      async *[Symbol.asyncIterator]() {
        invocation++
        yield { text: `answer ${invocation}`, type: "text-delta" }
        yield { type: "usage", usageRecord: { usage: { totalTokens: invocation } } }
      },
    }
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    for (let run = 0; run < 2; run++) {
      // SAFETY: The reusable driver returns the same raw async iterable for each invocation.
      const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
      for await (const _event of stream) {}
    }

    expect(finish.mock.calls.map(([event]) => event.result)).toMatchObject([
      { raw, text: "answer 1", usage: { totalTokens: 1 } },
      { raw, text: "answer 2", usage: { totalTokens: 2 } },
    ])
    expect(raw).not.toHaveProperty("text")
    expect(raw).not.toHaveProperty("usage")
    expect(raw).not.toHaveProperty("usageRecord")
  })

  it("adds streamed usage to preserved plain stream results", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usage } = await import("../src/capabilities/usage.ts")
    const result = {
      fullStream: (async function* () {
        yield { type: "usage", usageRecord: { usage: { totalTokens: 2 } } }
      })(),
    }
    const agent = defineAgent({
      capabilities: [usage()],
      driver: { run: () => result },
      hooks: { "agent:finish": vi.fn() },
    })

    // SAFETY: runAgent preserves this plain stream result and enriches it after consumption.
    const preserved = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as typeof result & {
      usage?: unknown
      usageRecord?: unknown
    }
    for await (const _event of preserved.fullStream) {}

    expect(preserved).toBe(result)
    expect(preserved).toMatchObject({
      usage: { totalTokens: 2 },
      usageRecord: { usage: { totalTokens: 2 } },
    })
  })

  it.each([
    { form: "stream", kind: "run" },
    { form: "run", kind: "model" },
  ] as const)("preserves a handled Response through $kind $form and defers finish", async ({ form, kind }) => {
    const { runAgent, streamAgent } = await import("../src/index.ts")
    const source = new Response("handled", {
      headers: { "x-lifecycle": "preserved" },
      status: 202,
    })
    const probe = await createLifecycleProbe(kind, form, {
      input(events) {
        events.push("input")
        return source
      },
    })

    const result = form === "run"
      ? await runAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })
      : await streamAgent(probe.agent, createInvocationRuntime(), { prompt: "hello" })
    expect(result).toBeInstanceOf(Response)
    // SAFETY: The preceding assertion verifies the handled result is a Response.
    const response = result as Response
    expect(response).not.toBe(source)
    expect(response.status).toBe(202)
    expect(response.headers.get("x-lifecycle")).toBe("preserved")
    probe.expectPending(["input"])
    expect(probe.execute).not.toHaveBeenCalled()

    await expect(response.text()).resolves.toBe("handled")
    probe.expectFinished(["input", "close", "finish"])
  })
})

describe("Agent Invocation lifecycle completion", () => {
  it("runs the first concurrent finish exactly once", async () => {
    const { openAgentInvocationLifecycle } = await import("../src/internal/invocation-lifecycle.ts")
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const finish = vi.fn(async () => { await gate })
    const lifecycle = await openAgentInvocationLifecycle(finish)

    const first = lifecycle.finish("first")
    const second = lifecycle.finish("second")
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(finish).toHaveBeenCalledWith("first")
  })
})
