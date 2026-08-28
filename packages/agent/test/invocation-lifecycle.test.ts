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

  it("does not await pending raw-stream usage after early termination", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = new Promise<never>(() => {})
    const raw = Object.assign((async function* () {
      yield { text: "partial", type: "text-delta" }
    })(), { usage })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await iterator.return?.()

    expect(finish).toHaveBeenCalledOnce()
  })

  it("does not await pending raw-stream usage after full consumption", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = new Promise<never>(() => {})
    const raw = Object.assign((async function* () {
      yield { text: "complete", type: "text-delta" }
    })(), { usage })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    const events = []
    for await (const event of stream) events.push(event)

    expect(events).toHaveLength(1)
    expect(finish).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ raw, text: "complete" }),
    }))
    expect(finish.mock.calls[0]![0].result).not.toHaveProperty("usage")
  })

  it("does not await pending raw-stream usage before streamAgent final rendering", async () => {
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = new Promise<never>(() => {})
    const raw = Object.assign((async function* () {
      yield { text: "complete", type: "text-delta" }
    })(), { usage })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "final-output",
        output(context) {
          context.output.final(result => result)
        },
      })],
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: streamAgent returns an async iterable when the capability provides final streamed output.
    const stream = await streamAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].result).toMatchObject({ raw, text: "complete" })
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

  it("records top-level usage when finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const providerUsage = { completionTokens: 3, promptTokens: 2, providerMetadata: "private" }
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    const raw = Object.assign((async function* () {
      yield { text: "answer", type: "text-delta" }
    })(), { usage: providerUsage })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { raw, text: "answer", usage, usageRecord: { usage } },
      invocation: { usage: { usage } },
    })
    expect(finish.mock.calls[0]![0].result.usage).toEqual(usage)
  })

  it("records promise-backed totalUsage when finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    const raw = Object.assign((async function* () {
      yield { text: "answer", type: "text-delta" }
    })(), { totalUsage: Promise.resolve({ completionTokens: 3, promptTokens: 2 }) })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ raw, text: "answer", usage, usageRecord: { usage } }),
      invocation: expect.objectContaining({ usage: expect.objectContaining({ usage }) }),
    }))
  })

  it("preserves details-only top-level usage when finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {})(), { usage: { details: { provider: 7 } } })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { usage: { details: { provider: 7 } } },
      invocation: { usage: { usage: { details: { provider: 7 } } } },
    })
  })

  it("preserves completed provider text when raw streams also emit text", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {
      yield { text: "partial", type: "text-delta" }
    })(), { text: "provider answer" })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({ result: { raw, text: "provider answer" } })
  })

  it("preserves promise-backed usage on raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = Promise.resolve({ inputTokens: 2, totalTokens: 2 })
    const raw = Object.assign((async function* () {
      yield { text: "answer", type: "text-delta" }
      yield { type: "usage", usageRecord: { model: "provider/model", usage: { outputTokens: 3 } } }
    })(), { usage })
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
        text: "answer",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 2 },
        usageRecord: { model: "provider/model", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 2 } },
      },
    })
  })

  it.each([
    { providerUsage: () => Promise.reject(new Error("usage unavailable")), scenario: "rejects" },
    { providerUsage: () => Promise.resolve("unusable"), scenario: "resolves to a non-object" },
  ])("falls back to streamed usage when provider usage $scenario", async ({ providerUsage }) => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {
      yield { type: "usage", usageRecord: { usage: { totalTokens: 2 } } }
    })(), { usage: providerUsage() })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { raw, usage: { totalTokens: 2 }, usageRecord: { usage: { totalTokens: 2 } } },
    })
  })

  it("skips throwing metadata getters on streamed usage events", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usageRecord = Object.defineProperties({ usage: { totalTokens: 2 } }, {
      response: {
        get() {
          throw new Error("unreadable streamed response metadata")
        },
      },
    })
    const raw = (async function* () {
      yield { type: "usage", usageRecord }
    })()
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { raw, usage: { totalTokens: 2 }, usageRecord: { usage: { totalTokens: 2 } } },
    })
  })

  it("merges nested usage on immutable raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {
      yield {
        type: "usage",
        usageRecord: {
          model: "provider/model",
          response: { finishReason: "stop" },
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
        response: { id: "response-id" },
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
        usageRecord: {
          model: "provider/model",
          response: { finishReason: "stop", id: "response-id" },
          usage,
        },
      },
    })
  })

  it("preserves accessor-backed nested usage on raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class InputTokenDetails {
      get cachedTokens() {
        return 2
      }
    }
    const raw = Object.assign((async function* () {
      yield {
        type: "usage",
        usageRecord: {
          usage: {
            details: Object.create({ streamed: 4 }),
            outputTokenDetails: Object.create({ reasoningTokens: 3 }),
          },
        },
      }
    })(), {
      usageRecord: {
        usage: { inputTokenDetails: new InputTokenDetails() },
      },
    })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        usage: {
          details: { streamed: 4 },
          inputTokenDetails: { cachedTokens: 2 },
          outputTokenDetails: { reasoningTokens: 3 },
        },
      },
    })
  })

  it("normalizes accessor-backed provider usage aliases on raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class Usage {
      get promptTokens() {
        return 2
      }

      get completion_tokens() {
        return 3
      }
    }
    const raw = Object.assign((async function* () {})(), { usage: new Usage() })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } },
    })
  })

  it("preserves provider metadata with top-level raw usage", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {})(), {
      modelId: "provider/model",
      provider: "gateway",
      response: { id: "response-1" },
      usage: { totalTokens: 3 },
    })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        usageRecord: {
          model: "provider/model",
          response: { id: "response-1" },
          transport: "gateway",
          usage: { totalTokens: 3 },
        },
      },
    })
  })

  it("preserves accessor-backed token details from top-level raw usage", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class InputTokenDetails {
      get cachedTokens() {
        return 2
      }
    }
    const raw = Object.assign((async function* () {})(), {
      usage: { inputTokenDetails: new InputTokenDetails() },
    })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { usage: { inputTokenDetails: { cachedTokens: 2 } } },
    })
  })

  it("filters invalid token details from top-level raw usage", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {})(), {
      usage: {
        inputTokenDetails: { cachedTokens: "invalid", cacheWriteTokens: 1 },
        inputTokens: 2,
        outputTokenDetails: { reasoningTokens: Number.NaN, textTokens: 3 },
        outputTokens: 3,
      },
    })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0].result.usage).toEqual({
      inputTokenDetails: { cacheWriteTokens: 1 },
      inputTokens: 2,
      outputTokenDetails: { textTokens: 3 },
      outputTokens: 3,
      totalTokens: 5,
    })
  })

  it("merges raw stream run annotations", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class ExistingAnnotations {
      get existing() {
        return "kept"
      }
    }
    const streamedAnnotations = Object.create({ streamed: "new" })
    const raw = Object.assign((async function* () {
      yield { type: "usage", usageRecord: { run: { annotations: streamedAnnotations } } }
    })(), { usageRecord: { run: { annotations: new ExistingAnnotations() } } })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { usageRecord: { run: { annotations: { existing: "kept", streamed: "new" } } } },
    })
  })

  it("skips unreadable run metadata while finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageRecordFromStreamChunk } = await import("../src/agent-output.ts")
    const finish = vi.fn()
    const annotations = Object.defineProperties({ readable: "kept", source: "provider" }, {
      unreadable: {
        enumerable: true,
        get() {
          throw new Error("unreadable run annotation")
        },
      },
    })
    const run = new Proxy({ annotations, runId: "provider-run" }, {
      get(target, key, receiver) {
        if (key === "messageId") throw new Error("unreadable run field")
        return Reflect.get(target, key, receiver)
      },
      ownKeys() {
        throw new Error("unreadable run metadata")
      },
    })
    const chunk = { type: "usage", usageRecord: { run, usage: { totalTokens: 2 } } }
    expect(usageRecordFromStreamChunk(chunk, undefined, {
      annotations: { invocation: "kept", source: "invocation" },
      messageId: "message-1",
      runId: "invocation-run",
    })).toMatchObject({
      run: {
        annotations: { invocation: "kept", readable: "kept", source: "provider" },
        messageId: "message-1",
        runId: "provider-run",
      },
    })
    const raw = (async function* () {
      yield chunk
    })()
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        usageRecord: {
          run: { annotations: { readable: "kept" }, runId: "provider-run" },
          usage: { totalTokens: 2 },
        },
      },
    })
  })

  it("normalizes inherited usage and ignores undefined existing counters", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class Usage {
      get inputTokens() {
        return undefined
      }

      get outputTokens() {
        return 3
      }
    }
    const raw = Object.assign((async function* () {
      yield { type: "usage", usageRecord: { usage: { inputTokens: 2, totalTokens: 5 } } }
    })(), { usage: new Usage() })
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
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
    })
  })

  it("skips throwing usage getters while finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const usage = Object.defineProperties({ totalTokens: 2 }, {
      // eslint-disable-next-line unicorn/no-thenable -- verifies unreadable promise metadata does not block finalization
      then: {
        get() {
          throw new Error("unreadable promise metadata")
        },
      },
      unreadable: {
        enumerable: true,
        get() {
          throw new Error("unreadable usage metadata")
        },
      },
    })
    const raw = Object.assign((async function* () {})(), { usage })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    // SAFETY: The finish hook receives the normalized result after successful stream consumption.
    const result = finish.mock.calls[0]![0].result as { raw?: unknown, usage?: unknown }
    expect(result.raw).toBe(raw)
    expect(result.usage).toEqual({ totalTokens: 2 })
  })

  it("skips throwing metadata existence checks while finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const error = vi.fn()
    const generator = (async function* () {
      yield { text: "hello", type: "text-delta" }
    })()
    const target = {
      [Symbol.asyncIterator]() {
        return generator
      },
    }
    const unreadableMetadata = new Set<PropertyKey>([
      "artifacts",
      "finishReason",
      "text",
      "totalUsage",
      "usage",
      "usageRecord",
      "warnings",
    ])
    const raw = new Proxy(target, {
      has(_target, key) {
        if (unreadableMetadata.has(key)) {
          throw new Error("unreadable provider metadata")
        }
        return Reflect.has(_target, key)
      },
      ownKeys() {
        throw new Error("unreadable provider descriptors")
      },
    })
    const agent = defineAgent({
      driver: { run: () => raw },
      hooks: { "agent:error": error, "agent:finish": finish },
    })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(error).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledOnce()
    // SAFETY: The finish hook receives the normalized result after successful stream consumption.
    const result = finish.mock.calls[0]![0].result as { raw?: unknown, text?: unknown }
    expect(result.raw).toBe(raw)
    expect(result.text).toBe("hello")
  })

  it("skips throwing usage detail enumeration while finalizing raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const details = new Proxy({}, {
      ownKeys() {
        throw new Error("unreadable usage descriptors")
      },
    })
    const raw = Object.assign((async function* () {})(), {
      usage: {
        details,
        inputTokenDetails: details,
        outputTokenDetails: details,
        totalTokens: 2,
      },
    })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({ result: { usage: { totalTokens: 2 } } })
  })

  it("preserves readable usage details around hostile accessors and prototypes", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const details = new Proxy(Object.defineProperties({}, {
      cachedTokens: { enumerable: true, value: 2 },
      unreadable: {
        enumerable: true,
        get() {
          throw new Error("unreadable usage detail")
        },
      },
    }), {
      getPrototypeOf() {
        throw new Error("unreadable usage prototype")
      },
    })
    const raw = Object.assign((async function* () {})(), {
      usage: { inputTokenDetails: details, totalTokens: 2 },
    })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: { usage: { inputTokenDetails: { cachedTokens: 2 }, totalTokens: 2 } },
    })
  })

  it("preserves inherited usage-record metadata on raw streams", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class ResponseMetadata {
      get id() {
        return "response-1"
      }
    }
    class UsageRecordMetadata {
      get calls() {
        return [{ model: "provider/call" }]
      }

      get cost() {
        return { display: "$0.01", estimated: false, source: "provider", usd: "0.01" }
      }

      get model() {
        return "provider/model"
      }

      get raw() {
        return { provider: "metadata" }
      }

      get response() {
        return new ResponseMetadata()
      }

      get transport() {
        return "gateway"
      }

      get usage() {
        return { totalTokens: 3 }
      }
    }
    const usageRecord = Object.defineProperty(new UsageRecordMetadata(), "credentialSource", {
      value: { label: "api key", source: "explicit" },
    })
    const raw = Object.assign((async function* () {
      yield { type: "usage", usageRecord: { response: { finishReason: "stop" } } }
    })(), { usageRecord })
    const agent = defineAgent({ driver: { run: () => raw }, hooks: { "agent:finish": finish } })

    // SAFETY: The driver returns the raw async iterable unchanged to the caller.
    const stream = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const _event of stream) {}

    expect(finish.mock.calls[0]![0]).toMatchObject({
      result: {
        raw,
        usage: { totalTokens: 3 },
        usageRecord: {
          calls: [{ model: "provider/call" }],
          cost: { display: "$0.01", estimated: false, source: "provider", usd: "0.01" },
          credentialSource: { label: "api key", source: "explicit" },
          model: "provider/model",
          raw: { provider: "metadata" },
          response: { finishReason: "stop", id: "response-1" },
          transport: "gateway",
          usage: { totalTokens: 3 },
        },
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

    expect(preserved).not.toBe(result)
    expect(preserved).toMatchObject({
      usage: { totalTokens: 2 },
      usageRecord: { usage: { totalTokens: 2 } },
    })
  })

  it("prefers observed usage when a preserved stream exits early", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usage } = await import("../src/capabilities/usage.ts")
    const finish = vi.fn()
    const result = {
      fullStream: (async function* () {
        yield { type: "usage", usageRecord: { usage: { totalTokens: 2 } } }
        yield { text: "unconsumed", type: "text-delta" }
      })(),
      usageRecord: { usage: { totalTokens: 1 } },
    }
    const agent = defineAgent({
      capabilities: [usage()],
      driver: { run: () => result },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: runAgent preserves this plain stream result and enriches it after consumption.
    const preserved = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as typeof result
    for await (const _event of preserved.fullStream) break

    expect(finish.mock.calls[0]![0]).toMatchObject({
      invocation: { usage: { usage: { totalTokens: 2 } } },
      result: { usage: { totalTokens: 2 }, usageRecord: { usage: { totalTokens: 2 } } },
    })
  })

  it("preserves snapshotted usage when a rendered UI stream exits early", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const raw = Object.assign((async function* () {
      yield { text: "unused", type: "text-delta" }
    })(), { usageRecord: { usage: { totalTokens: 3 } } })
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "ui-renderer",
        output(context) {
          context.output.render(() => ({
            toUIMessageStream: () => new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "start" })
              },
            }),
          }))
        },
      })],
      driver: { run: () => raw },
      hooks: { "agent:finish": finish },
    })

    // SAFETY: The output renderer exposes the UI message stream method inspected here.
    const result = await runAgent(agent, createInvocationRuntime(), { prompt: "hello" }) as {
      toUIMessageStream: () => ReadableStream<unknown>
    }
    const reader = result.toUIMessageStream().getReader()
    await reader.read()
    await reader.cancel()

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0]).toMatchObject({
      invocation: { usage: { usage: { totalTokens: 3 } } },
      result: { usage: { totalTokens: 3 }, usageRecord: { usage: { totalTokens: 3 } } },
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
