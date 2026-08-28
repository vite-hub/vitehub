import { describe, expect, it, vi } from "vitest"
import { array, is, object, string } from "valibot"

import { defineAgent, defineCapability, runAgentInline, streamAgentInline } from "../src/index.ts"
import { createAiSdkAdapter } from "../src/ai-sdk.ts"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { validateAgentOutput } from "../src/internal/agent-structured-output.ts"
import { normalizeUiMessageStreamChunk } from "../src/stream-output.ts"

import type { AgentFinishHookEvent } from "../src/index.ts"

vi.mock("#vitehub/agent/registry", () => ({ default: {} }))

const stringSchema = string()

const outputSchema = {
  "~standard": {
    jsonSchema: {
      input: () => ({
        properties: { text: { type: "string" } },
        required: ["text"],
        type: "object",
      }),
      output: () => ({ type: "object" }),
    },
    validate(value: unknown) {
      return is(object({ text: stringSchema }), value)
        ? { value }
        : { issues: [{ message: "Expected text to be a string" }] }
    },
    vendor: "vitehub-test",
    version: 1 as const,
  },
}

const arbitraryOutputSchema = {
  "~standard": {
    jsonSchema: {
      input: () => ({
        properties: { nextAction: { type: "string" }, priority: { type: "string" } },
        required: ["nextAction", "priority"],
        type: "object",
      }),
      output: () => ({ type: "object" }),
    },
    validate(value: unknown) {
      return is(object({ nextAction: stringSchema, priority: stringSchema }), value)
        ? { value }
        : { issues: [{ message: "Expected nextAction and priority strings" }] }
    },
    vendor: "vitehub-test",
    version: 1 as const,
  },
}

type ModelContent = Array<Record<string, unknown>>
type ModelCall = { abortSignal?: AbortSignal, prompt: unknown, responseFormat?: unknown }
type ModelResponse = ModelContent | string | ((options: ModelCall) => Promise<ModelContent | string>)

function model(responses: ModelResponse[]) {
  const calls: ModelCall[] = []
  return {
    calls,
    async doGenerate(options: ModelCall) {
      calls.push(options)
      const response = responses[calls.length - 1]
      if (response === undefined) throw new Error("Unexpected model call")
      const resolvedResponse = response instanceof Function ? await response(options) : response
      return {
        content: is(stringSchema, resolvedResponse) ? [{ text: resolvedResponse, type: "text" }] : resolvedResponse,
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      }
    },
    async doStream() {
      throw new Error("Unexpected streaming model call")
    },
    modelId: "vitehub-recovery-test",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

function streamingRepairModel() {
  const usage = {
    inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
    outputTokens: { reasoning: 0, text: 1, total: 1 },
  }
  let cancelCount = 0
  let pullCount = 0
  let streamCall = 0
  const doGenerate = vi.fn(async (_options?: ModelCall) => ({
    content: [{ text: "{\"query\":\"fixed\"}", type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    providerMetadata: { test: { usage: { cost: 0.2 } } },
    usage,
    warnings: [],
  }))
  const doStream = vi.fn(async () => {
    streamCall += 1
    const events = streamCall === 1
      ? [
          { type: "stream-start", warnings: [] },
          { input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" },
          { finishReason: { raw: "tool-calls", unified: "tool-calls" }, providerMetadata: { test: { usage: { cost: 0.1 } } }, type: "finish", usage },
        ]
      : [
          { type: "stream-start", warnings: [] },
          { id: "answer", type: "text-start" },
          { delta: "Finished", id: "answer", type: "text-delta" },
          { id: "answer", type: "text-end" },
          { finishReason: { raw: "stop", unified: "stop" }, providerMetadata: { test: { usage: { cost: 0.1 } } }, type: "finish", usage },
        ]
    return {
      stream: new ReadableStream({
        cancel() {
          cancelCount += 1
        },
        pull(controller) {
          pullCount += 1
          const event = events.shift()
          if (event) controller.enqueue(event)
          if (events.length === 0) controller.close()
        },
      }, { highWaterMark: 0 }),
    }
  })
  return {
    get cancelCount() {
      return cancelCount
    },
    doGenerate,
    doStream,
    get pullCount() {
      return pullCount
    },
    modelId: "vitehub-stream-recovery-test",
    provider: "test",
    specificationVersion: "v3",
    supportedUrls: {},
  }
}

const runtime = {
  memo: <T>(_key: string, create: () => T) => create(),
  runtime: "unknown" as const,
  waitUntil: () => undefined,
}

async function rawStreamingResult(beforeFirstEvent?: Promise<void>, onFirstEventRequested?: () => void, onCancel?: () => void) {
  let started = false
  const fakeModel = {
    ...model([]),
    async doStream(options: { abortSignal?: AbortSignal }) {
      return {
        stream: new ReadableStream({
          cancel() {
            onCancel?.()
          },
          async pull(controller) {
            if (started) return
            started = true
            onFirstEventRequested?.()
            if (beforeFirstEvent) {
              await Promise.race([
                beforeFirstEvent,
                new Promise<void>((resolve) => options.abortSignal?.addEventListener("abort", () => resolve(), { once: true })),
              ])
            }
            if (options.abortSignal?.aborted) return
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ id: "answer", type: "text-start" })
            controller.enqueue({ delta: "Finished", id: "answer", type: "text-delta" })
            controller.enqueue({ id: "answer", type: "text-end" })
            controller.enqueue({ finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
            controller.close()
          },
        }, { highWaterMark: 0 }),
      }
    },
  }
  const invoker = { id: "recovery-test", kind: "user" }
  // SAFETY: The fake model implements the AI SDK streaming model contract exercised by this test.
  return await createAiSdkAdapter({ model: fakeModel as never }).stream!({
    actor: invoker,
    context: createAgentInvocationContextStore(),
    input: {},
    invoker,
    messages: [],
    prompt: "Respond",
    runtime,
  } as never)
}

const toolInputSchema = {
  "~standard": {
    jsonSchema: {
      input: () => ({
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object",
      }),
      output: () => ({ type: "object" }),
    },
    validate(value: unknown) {
      return is(object({ query: stringSchema }), value)
        ? { value }
        : { issues: [{ message: "Expected query to be a string" }] }
    },
    vendor: "vitehub-test",
    version: 1 as const,
  },
}

function toolCallingAgent(
  fakeModel: unknown,
  execute: (input: unknown) => string,
  repairToolCall?: boolean,
  finish?: (event: AgentFinishHookEvent) => void,
  structuredOutput = false,
) {
  return defineAgent({
    capabilities: [defineCapability({
      id: "search-test",
      tools: {
        search: {
          execute,
          inputSchema: toolInputSchema,
          name: "search",
        },
      },
    })],
    driver: {
      execution: repairToolCall === undefined ? undefined : { repairToolCall },
      // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
      model: fakeModel as never,
      ...(structuredOutput ? { output: { schema: outputSchema } } : {}),
    },
    ...(finish ? { hooks: { "agent:finish": finish } } : {}),
    runtime: false,
  })
}

describe("AI SDK recovery", () => {
  it("preserves null UI-message chunks at the provider boundary", () => {
    expect(normalizeUiMessageStreamChunk(null)).toBeNull()
  })

  it("preserves provider cost from generated result getters", async () => {
    const finish = vi.fn()
    const fakeModel = model(["Finished"])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async options => ({
      ...await doGenerate(options),
      providerMetadata: { test: { usage: { cost: 0.1 } } },
    })

    await runAgentInline(toolCallingAgent(fakeModel, vi.fn(), undefined, finish), runtime, { prompt: "Respond" })

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
      }),
    }))
  })

  it("repairs structured output with three total attempts by default", async () => {
    const fakeModel = model(["{\"text\":1}", "{\"text\":2}", "{\"text\":\"repaired\"}"])
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).resolves.toEqual({ text: "repaired" })
    expect(fakeModel.calls).toHaveLength(3)
  })

  it.each(["generate", "stream"] as const)("enforces the invocation timeout while %s setup is pending", async (method) => {
    const timeoutController = new AbortController()
    const timeoutError = new DOMException("setup timed out", "TimeoutError")
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal)
    let markResolverStarted!: () => void
    const resolverStarted = new Promise<void>((resolve) => { markResolverStarted = resolve })
    let resolverSignal: AbortSignal | undefined
    try {
      // SAFETY: This fixture implements the model resolver callback exercised by the pending-setup timeout path.
      const pendingModelResolver = ((context: { abortSignal?: AbortSignal }) => {
        resolverSignal = context.abortSignal
        markResolverStarted()
        return new Promise<never>(() => undefined)
      }) as never
      const agent = defineAgent({
        driver: {
          model: pendingModelResolver,
        },
        runtime: false,
      })
      const invocation = method === "generate"
        ? runAgentInline(agent, runtime, { prompt: "Respond", timeout: 100 })
        : streamAgentInline(agent, runtime, { prompt: "Respond", timeout: 100 })

      await resolverStarted
      expect(resolverSignal).toBeDefined()
      timeoutController.abort(timeoutError)

      await expect(invocation).rejects.toBe(timeoutError)
      expect(resolverSignal?.aborted).toBe(true)
    }
    finally {
      timeoutSpy.mockRestore()
    }
  })

  it("rejects a pending provider read when the invocation deadline expires", async () => {
    const timeoutController = new AbortController()
    const timeoutError = new DOMException("stream timed out", "TimeoutError")
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal)
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
    try {
      const fakeModel = {
        ...model([]),
        async doStream() {
          return {
            stream: new ReadableStream({
              pull() {
                markReadStarted()
              },
            }, { highWaterMark: 0 }),
          }
        },
      }
      const agent = defineAgent({
        driver: {
          // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
          model: fakeModel as never,
        },
        runtime: false,
      })
      const result = await streamAgentInline(agent, runtime, { prompt: "Respond", timeout: 100 })
      const consumption = (async () => {
        // SAFETY: streamAgentInline returns the documented async iterable result contract.
        for await (const _event of result as AsyncIterable<unknown>) {}
      })()

      await readStarted
      timeoutController.abort(timeoutError)

      await expect(consumption).rejects.toBe(timeoutError)
    }
    finally {
      timeoutSpy.mockRestore()
    }
  })

  it("shares the invocation timeout with structured output corrections", async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    try {
      const fakeModel = model([
        async () => {
          now += 80
          return "{\"text\":1}"
        },
        "{\"text\":\"repaired\"}",
      ])
      const agent = defineAgent({
        driver: {
          // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
          model: fakeModel as never,
          output: { schema: outputSchema },
        },
        runtime: false,
      })

      await expect(runAgentInline(agent, runtime, { prompt: "Respond", timeout: 100 })).resolves.toEqual({ text: "repaired" })

      expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([100, 100, 20])
    }
    finally {
      timeoutSpy.mockRestore()
      nowSpy.mockRestore()
    }
  })

  it("reports completed usage when structured output corrections fail", async () => {
    const fakeModel = model(["{\"text\":1}", "{\"text\":2}", "{\"text\":3}"])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async (options) => ({
      ...await doGenerate(options),
      providerMetadata: { test: { usage: { cost: fakeModel.calls.length / 10 } } },
    })
    const agentError = vi.fn()
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { schema: outputSchema },
      },
      hooks: { "agent:error": agentError },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).rejects.toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })

    expect(agentError).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.3" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.6" }),
          usage: expect.objectContaining({ totalTokens: 6 }),
        }),
      }),
    }))
  })

  it("repairs structured output before applying an output renderer", async () => {
    const fakeModel = model(["{\"text\":1}", "{\"text\":\"repaired\"}"])
    const render = vi.fn((result: unknown) => result)
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "output-renderer",
        output(context) {
          context.output.render(render)
        },
      })],
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).resolves.toEqual({ text: "repaired" })
    expect(render).toHaveBeenCalledWith({ text: "repaired" }, expect.anything())
    expect(fakeModel.calls).toHaveLength(2)
  })

  it("repairs streamed structured output before applying a final-output renderer", async () => {
    const fakeModel = model(["{\"text\":\"repaired\"}"])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":1}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const render = vi.fn((result: unknown) => result)
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "final-output-renderer",
        output(context) {
          context.output.final(render)
        },
      })],
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    const events = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual({ data: { text: "repaired" }, type: "data" })
    expect(render).toHaveBeenCalledWith({ text: "repaired" }, expect.anything())
    expect(fakeModel.calls).toHaveLength(1)
  })

  it("repairs invalid structured output from streamed invocations", async () => {
    let releaseRepair!: () => void
    const repairReleased = new Promise<void>((resolve) => { releaseRepair = resolve })
    const fakeModel = model([async () => {
      await repairReleased
      return "{\"text\":\"repaired\"}"
    }])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async options => ({
      ...await doGenerate(options),
      providerMetadata: { test: { usage: { cost: 0.2 } } },
    })
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":1}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            providerMetadata: { test: { usage: { cost: 0.1 } } },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      hooks: { "agent:finish": finish },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    // SAFETY: streamAgentInline exposes the AI SDK usage promise on its documented stream result.
    const earlyUsage = (result as { usage: Promise<unknown> }).usage
    const events: unknown[] = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    const iterable = result as AsyncIterable<unknown>
    const consumption = (async () => {
      for await (const event of iterable) events.push(event)
    })()
    await vi.waitFor(() => expect(fakeModel.calls).toHaveLength(1))
    let usageSettled = false
    void earlyUsage.then(() => { usageSettled = true })
    await Promise.resolve()
    expect(usageSettled).toBe(false)
    releaseRepair()
    await consumption

    expect(events).not.toContainEqual(expect.objectContaining({ type: "error" }))
    expect(events).toContainEqual(expect.objectContaining({ type: "finish" }))
    // SAFETY: Every collected event is inspected only for its optional discriminant.
    const usageEvents = events.filter(event => (event as { type?: unknown }).type === "usage")
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      usageRecord: {
        calls: expect.arrayContaining([
          expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
          expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
        ]),
        cost: expect.objectContaining({ usd: "0.3" }),
        usage: expect.objectContaining({ totalTokens: 4 }),
      },
    })
    await expect(earlyUsage).resolves.toMatchObject({ totalTokens: 4 })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: expect.arrayContaining([
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ]),
          cost: expect.objectContaining({ usd: "0.3" }),
        }),
      }),
    }))
  })

  it("shares the invocation timeout with streamed structured output corrections", async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    try {
      const fakeModel = model(["{\"text\":\"repaired\"}"])
      const doStream = vi.fn(async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ id: "answer", type: "text-start" })
            controller.enqueue({ delta: "{\"text\":1}", id: "answer", type: "text-delta" })
            controller.enqueue({ id: "answer", type: "text-end" })
            now += 80
            controller.enqueue({
              finishReason: { raw: "stop", unified: "stop" },
              type: "finish",
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            })
            controller.close()
          },
        }),
      }))
      const agent = defineAgent({
        driver: {
          // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
          model: { ...fakeModel, doStream } as never,
          output: { schema: outputSchema },
        },
        runtime: false,
      })

      const result = await streamAgentInline(agent, runtime, { prompt: "Respond", timeout: 100 })
      // SAFETY: streamAgentInline returns the documented async iterable result contract.
      for await (const _event of result as AsyncIterable<unknown>) {}

      expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([100, 100, 20])
    }
    finally {
      timeoutSpy.mockRestore()
      nowSpy.mockRestore()
    }
  })

  it.each(["events", "ui-message-stream"] as const)("aborts structured output corrections when the %s consumer cancels", async (output) => {
    let markRepairStarted!: () => void
    const repairStarted = new Promise<void>((resolve) => { markRepairStarted = resolve })
    let repairAbortReason: unknown
    const fakeModel = model([async ({ abortSignal }) => {
      markRepairStarted()
      if (!abortSignal) throw new Error("Expected correction to inherit stream cancellation")
      return await new Promise<string>((_resolve, reject) => {
        const abort = () => {
          repairAbortReason = abortSignal.reason
          reject(abortSignal.reason)
        }
        if (abortSignal.aborted) abort()
        else abortSignal.addEventListener("abort", abort, { once: true })
      })
    }])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":1}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" }, output === "events" ? undefined : { output })
    if (output === "ui-message-stream") {
      // SAFETY: UI-message output is a ReadableStream under the selected output contract.
      const reader = (result as ReadableStream<unknown>).getReader()
      const consumption = (async () => {
        while (!(await reader.read()).done) {}
      })().catch(() => undefined)
      await repairStarted
      await reader.cancel()
      await consumption
    }
    else {
      // SAFETY: events output implements the documented async iterable result contract.
      const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      const consumption = (async () => {
        while (!(await iterator.next()).done) {}
      })().catch(() => undefined)
      await repairStarted
      await iterator.return?.()
      await consumption
    }

    expect(repairAbortReason).toMatchObject({ name: "AbortError" })
  })

  it("emits all completed usage when streamed structured-output repair fails", async () => {
    const fakeModel = model(["{\"text\":2}", "{\"text\":3}"])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async options => ({
      ...await doGenerate(options),
      providerMetadata: { test: { usage: { cost: 0.2 } } },
    })
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":1}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            providerMetadata: { test: { usage: { cost: 0.1 } } },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    const events: unknown[] = []
    let error: unknown
    try {
      // SAFETY: streamAgentInline returns the documented async iterable result contract.
      for await (const event of result as AsyncIterable<unknown>) events.push(event)
    }
    catch (cause) {
      error = cause
    }

    expect(error).toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })
    // SAFETY: Collected Agent stream events expose an optional discriminant used only for filtering.
    const usageEvents = events.filter(event => (event as { type?: unknown }).type === "usage")
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0]).toMatchObject({
      usageRecord: {
        calls: [
          expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
          expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
        ],
        cost: expect.objectContaining({ usd: "0.5" }),
        usage: expect.objectContaining({ totalTokens: 6 }),
      },
    })
  })

  it("reports all completed usage when UI-message structured-output repair fails", async () => {
    const fakeModel = model(["{\"text\":2}", "{\"text\":3}"])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async options => ({
      ...await doGenerate(options),
      providerMetadata: { test: { usage: { cost: 0.2 } } },
    })
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":1}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            providerMetadata: { test: { usage: { cost: 0.1 } } },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const agentError = vi.fn()
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      hooks: { "agent:error": agentError },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" }, { output: "ui-message-stream" })
    await expect(async () => {
      // SAFETY: UI-message stream output implements the documented async iterable result contract.
      for await (const _event of result as AsyncIterable<unknown>) {}
    }).rejects.toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })

    expect(agentError).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.5" }),
          usage: expect.objectContaining({ totalTokens: 6 }),
        }),
      }),
    }))
  })

  it("repairs streamed output when native object output is unavailable", async () => {
    const fakeModel = model(['"repaired"'])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "1", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({ finishReason: { raw: "stop", unified: "stop" }, type: "finish", usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } })
          controller.close()
        },
      }),
    }))
    const scalarSchema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "string" }), output: () => ({ type: "string" }) },
        validate(value: unknown) {
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The test schema deliberately validates an unknown scalar at its Standard Schema boundary.
          return typeof value === "string" ? { value } : { issues: [{ message: "Expected string" }] }
        },
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
    const agent = defineAgent({ driver: { model: { ...fakeModel, doStream } as never, output: { schema: scalarSchema } }, runtime: false })
    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    const events = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)
    expect(events).toContainEqual({ data: "repaired", type: "data" })
  })

  it.each([true, false])("includes completed tool evidence when repairing streamed structured output with workspace fallback %s", async (workspaceFallback) => {
    const fakeModel = streamingRepairModel()
    fakeModel.doGenerate.mockImplementationOnce(async (options?: ModelCall) => {
      expect(JSON.stringify(options?.prompt)).toContain("found")
      return {
        content: [{ text: '{"text":"repaired"}', type: "text" }],
        finishReason: { raw: "stop", unified: "stop" },
        providerMetadata: { test: { usage: { cost: 0.2 } } },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      }
    })
    fakeModel.doStream.mockImplementationOnce(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ input: '{"query":"users"}', toolCallId: "call-1", toolName: "search", type: "tool-call" })
          controller.enqueue({
            finishReason: { raw: "tool-calls", unified: "tool-calls" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    })).mockImplementationOnce(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"text":1}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        execution: { workspaceFallback },
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Search" })
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) {}

    expect(fakeModel.doGenerate).toHaveBeenCalledOnce()
  })

  it.each([
    { maxAttempts: 1, modelCalls: 1 },
    { maxAttempts: 2, modelCalls: 2 },
  ])("limits generated Workspace fallback to $maxAttempts structured output attempts", async ({ maxAttempts, modelCalls }) => {
    const fakeModel = model([
      [{ input: '{"query":"users"}', toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      '{"text":1}',
      '{"text":"must not run"}',
    ])
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        execution: { stepLimit: 1, workspaceFallback: true },
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { maxAttempts, schema: outputSchema },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Search" })).rejects.toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })
    expect(fakeModel.calls).toHaveLength(modelCalls)
  })

  it("counts streamed Workspace fallback synthesis against structured output attempts", async () => {
    const fallbackModel = model(['{"text":1}', '{"text":"must not run"}'])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ input: '{"query":"users"}', toolCallId: "call-1", toolName: "search", type: "tool-call" })
          controller.enqueue({
            finishReason: { raw: "tool-calls", unified: "tool-calls" },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        execution: { stepLimit: 1, workspaceFallback: true },
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fallbackModel, doStream } as never,
        output: { maxAttempts: 2, schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Search" })
    await expect(async () => {
      // SAFETY: streamAgentInline returns the documented async iterable result contract.
      for await (const _event of result as AsyncIterable<unknown>) {}
    }).rejects.toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })
    expect(doStream).toHaveBeenCalledOnce()
    expect(fallbackModel.calls).toHaveLength(1)
  })

  it("includes streamed workspace fallback synthesis in invocation usage", async () => {
    const baseModel = model(["Synthesized from the workspace"])
    const fakeModel = {
      ...baseModel,
      doGenerate: vi.fn(async (options: ModelCall) => ({
        ...await baseModel.doGenerate(options),
        providerMetadata: { test: { usage: { cost: 0.2 } } },
      })),
      doStream: vi.fn(async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ input: "{\"query\":\"users\"}", toolCallId: "call-1", toolName: "search", type: "tool-call" })
            controller.enqueue({
              finishReason: { raw: "tool-calls", unified: "tool-calls" },
              providerMetadata: { test: { usage: { cost: 0.1 } } },
              type: "finish",
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
            })
            controller.close()
          },
        }),
      })),
    }
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        execution: { stepLimit: 1, workspaceFallback: true },
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
      },
      hooks: { "agent:finish": finish },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Search" })
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) {}

    expect(fakeModel.doGenerate).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.3" }),
          usage: expect.objectContaining({ totalTokens: 4 }),
        }),
      }),
    }))
  })

  it("retains streamed workspace fallback usage when synthesis is empty", async () => {
    const baseModel = model([""])
    const fakeModel = {
      ...baseModel,
      doGenerate: vi.fn(async (options: ModelCall) => ({
        ...await baseModel.doGenerate(options),
        providerMetadata: { test: { usage: { cost: 0.2 } } },
      })),
      doStream: vi.fn(async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ input: "{\"query\":\"users\"}", toolCallId: "call-1", toolName: "search", type: "tool-call" })
            controller.enqueue({
              finishReason: { raw: "tool-calls", unified: "tool-calls" },
              providerMetadata: { test: { usage: { cost: 0.1 } } },
              type: "finish",
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
            })
            controller.close()
          },
        }),
      })),
    }
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        execution: { stepLimit: 1, workspaceFallback: true },
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
      },
      hooks: { "agent:finish": finish },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Search" })
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) {}

    expect(fakeModel.doGenerate).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.3" }),
          usage: expect.objectContaining({ totalTokens: 4 }),
        }),
      }),
    }))
  })

  it("emits arbitrary structured output from streamed invocations", async () => {
    const fakeModel = model([])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"nextAction":"email","priority":"high"}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: arbitraryOutputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    const events = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual({ data: { nextAction: "email", priority: "high" }, type: "data" })
    expect(events).toContainEqual(expect.objectContaining({ type: "finish" }))
  })

  it("materializes structured output when usage is awaited first", async () => {
    const fakeModel = model([])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":\"answer\"}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    // SAFETY: The streamed result preserves the AI SDK usage accessor alongside the public event stream.
    await expect((result as { usage: Promise<unknown> }).usage).resolves.toMatchObject({ totalTokens: 2 })
    const events = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual({ data: { text: "answer" }, type: "data" })
  })

  it("materializes structured output when usage is awaited after one event", async () => {
    const fakeModel = model([])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: "{\"text\":\"answer\"}", id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    // SAFETY: Streaming agent results implement the public async iterable event contract.
    const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    // SAFETY: The streamed result preserves the AI SDK usage accessor alongside the public event stream.
    await expect((result as { usage: Promise<unknown> }).usage).resolves.toMatchObject({ totalTokens: 2 })
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { data: { text: "answer" }, type: "data" } })
  })

  it("parses streamed JSON before accepting a structured result envelope", async () => {
    const fakeModel = model([])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"text":"answer"}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    const events = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual({ data: { text: "answer" }, type: "data" })
  })

  it("emits complete text-bearing structured output from streamed invocations", async () => {
    const fakeModel = model([])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"text":"answer","citations":["source"]}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const textWithCitationsSchema = {
      "~standard": {
        jsonSchema: {
          input: () => ({ type: "object" }),
          output: () => ({ type: "object" }),
        },
        validate(value: unknown) {
          return is(object({ citations: array(stringSchema), text: stringSchema }), value)
            ? { value }
            : { issues: [{ message: "Expected text and citations" }] }
        },
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: textWithCitationsSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" })
    const events = []
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual({ data: { citations: ["source"], text: "answer" }, type: "data" })
  })

  it("repairs invalid structured output from UI-message streamed invocations", async () => {
    const fakeModel = model(['{"text":"repaired"}'])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"text":1}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: {
              inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
              outputTokens: { reasoning: 0, text: 1, total: 1 },
            },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema: outputSchema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" }, { output: "ui-message-stream" })
    const events = []
    // SAFETY: UI-message stream output implements the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual(expect.objectContaining({ delta: "repaired", type: "text-delta" }))
    expect(fakeModel.calls).toHaveLength(1)
  })

  it.each(["events", "ui-message-stream"] as const)("validates each %s structured stream once", async (output) => {
    const fakeModel = model([])
    const validate = vi.fn((value: unknown) => is(object({ text: stringSchema }), value)
      ? { value: { text: "validated" } }
      : { issues: [{ message: "Expected text to be a string" }] })
    const schema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "object" }), output: () => ({ type: "object" }) },
        validate,
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"text":"answer"}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: { schema },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" }, output === "events" ? undefined : { output })
    const events = []
    // SAFETY: Both selected output modes implement the documented async iterable result contract.
    for await (const event of result as AsyncIterable<unknown>) events.push(event)

    expect(events).toContainEqual(expect.objectContaining({
      data: { text: "validated" },
      type: output === "events" ? "data" : "data-event",
    }))
    expect(validate).toHaveBeenCalledTimes(1)
  })

  it("validates a repaired non-stream result once", async () => {
    const fakeModel = model(['{"text":1}', '{"text":"repaired"}'])
    const validatedInputs: unknown[] = []
    const schema = {
      "~standard": {
        jsonSchema: { input: () => ({ type: "object" }), output: () => ({ type: "object" }) },
        validate(value: unknown) {
          validatedInputs.push(value)
          return is(object({ text: stringSchema }), value)
            ? { value: { text: "validated" } }
            : { issues: [{ message: "Expected text to be a string" }] }
        },
        vendor: "vitehub-test",
        version: 1 as const,
      },
    }
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { schema },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).resolves.toEqual({ text: "validated" })
    expect(validatedInputs.filter(value => is(object({ text: stringSchema }), value))).toHaveLength(1)
  })

  it("validates direct structured results independently", async () => {
    const result = { text: "{\"text\":\"answer\"}" }
    const validate = vi.fn(outputSchema["~standard"].validate)
    const output = { schema: { "~standard": { ...outputSchema["~standard"], validate } } }

    await validateAgentOutput(output, result)
    await validateAgentOutput(output, result)
    await validateAgentOutput(output, result)

    expect(validate).toHaveBeenCalledTimes(3)
  })

  it("allows structured-output repair to be disabled", async () => {
    const fakeModel = model(["{\"text\":1}", "{\"text\":\"must not run\"}"])
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { maxAttempts: 1, schema: outputSchema },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).rejects.toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })
    expect(fakeModel.calls).toHaveLength(1)
  })

  it("propagates operational output validator failures without repair", async () => {
    const unavailable = new Error("validator unavailable")
    const fakeModel = model(["{\"text\":\"valid\"}", "{\"text\":\"must not run\"}"])
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: {
          schema: {
            "~standard": {
              validate: async () => { throw unavailable },
              vendor: "vitehub-test",
              version: 1 as const,
            },
          },
        },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).rejects.toBe(unavailable)
    expect(fakeModel.calls).toHaveLength(1)
  })

  it.each(["events", "ui-message-stream"] as const)("propagates operational validator failures from %s streams without repair", async (output) => {
    const unavailable = new Error("validator unavailable")
    const fakeModel = model(['{"text":"must not run"}'])
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          controller.enqueue({ id: "answer", type: "text-start" })
          controller.enqueue({ delta: '{"text":"valid"}', id: "answer", type: "text-delta" })
          controller.enqueue({ id: "answer", type: "text-end" })
          controller.enqueue({
            finishReason: { raw: "stop", unified: "stop" },
            type: "finish",
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          })
          controller.close()
        },
      }),
    }))
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: { ...fakeModel, doStream } as never,
        output: {
          schema: {
            "~standard": {
              validate: async () => { throw unavailable },
              vendor: "vitehub-test",
              version: 1 as const,
            },
          },
        },
      },
      runtime: false,
    })

    const result = await streamAgentInline(agent, runtime, { prompt: "Respond" }, output === "events" ? undefined : { output })
    await expect(async () => {
      // SAFETY: Both selected output modes implement the documented async iterable result contract.
      for await (const _event of result as AsyncIterable<unknown>) {}
    }).rejects.toBe(unavailable)
    expect(fakeModel.calls).toHaveLength(0)
  })

  it("propagates operational output validator failures from workspace fallback without repair", async () => {
    const unavailable = new Error("validator unavailable")
    const fakeModel = model([
      [{ input: '{"query":"users"}', toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "",
      '{"text":"workspace answer"}',
      '{"text":"must not run"}',
    ])
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: {
          schema: {
            "~standard": {
              validate: async () => { throw unavailable },
              vendor: "vitehub-test",
              version: 1 as const,
            },
          },
        },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Search" })).rejects.toBe(unavailable)
    expect(fakeModel.calls).toHaveLength(3)
  })

  it("rejects invalid structured-output attempt limits", async () => {
    const fakeModel = model(["{\"text\":\"unused\"}"])
    const agent = defineAgent({
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
        output: { maxAttempts: 0, schema: outputSchema },
      },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).rejects.toThrow("maxAttempts must be a positive integer")
    expect(fakeModel.calls).toHaveLength(0)
  })

  it("repairs invalid arguments for an existing tool by default", async () => {
    const executions = vi.fn(() => "found")
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "{\"query\":\"fixed\"}",
      "Finished",
    ])

    const result = await runAgentInline(toolCallingAgent(fakeModel, executions), runtime, { prompt: "Search" })

    expect(result).toMatchObject({ text: "Finished" })
    expect(executions).toHaveBeenCalledWith({ query: "fixed" }, expect.anything())
    expect(fakeModel.calls).toHaveLength(3)
    expect(fakeModel.calls[1]?.responseFormat).toBeDefined()
  })

  it("retains the original tool-input failure when repaired arguments remain invalid", async () => {
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "{\"query\":2}",
    ])

    await expect(runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, { prompt: "Search" })).rejects.toMatchObject({
      name: "AI_InvalidToolInputError",
      toolName: "search",
    })
    expect(fakeModel.calls).toHaveLength(2)
  })

  it("shares the invocation timeout with tool-call repair", async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now)
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout")
    try {
      const fakeModel = model([
        async () => {
          now += 80
          return [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }]
        },
        "{\"query\":\"fixed\"}",
        "Finished",
      ])

      await expect(runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, {
        prompt: "Search",
        timeout: 100,
      })).resolves.toMatchObject({ text: "Finished" })

      expect(timeoutSpy.mock.calls.map(([timeout]) => timeout)).toEqual([100, 100, 20])
    }
    finally {
      timeoutSpy.mockRestore()
      nowSpy.mockRestore()
    }
  })

  it("keeps final-result metadata off tool-call repair usage", async () => {
    const finish = vi.fn()
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "{\"query\":\"fixed\"}",
      "Finished",
    ])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async (options) => {
      const result = await doGenerate(options)
      return {
        ...result,
        providerMetadata: { test: { usage: { cost: fakeModel.calls.length / 10 } } },
      }
    }

    await runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, finish), runtime, { prompt: "Search" })

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: expect.arrayContaining([
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.3" }) }),
          ]),
          cost: expect.objectContaining({ usd: "0.5" }),
        }),
      }),
    }))
  })

  it("does not apply final-output instructions to tool-call repair", async () => {
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "{\"query\":\"fixed\"}",
      "{\"text\":\"Finished\"}",
    ])

    await runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), runtime, { prompt: "Search" })

    expect(JSON.stringify(fakeModel.calls[0]?.prompt)).toContain("configured Agent output")
    expect(JSON.stringify(fakeModel.calls[1]?.prompt)).not.toContain("configured Agent output")
  })

  it("aborts a pending tool-call repair with the invocation", async () => {
    const controller = new AbortController()
    const stopped = new Error("stopped")
    let markRepairStarted!: () => void
    const repairStarted = new Promise<void>((resolve) => {
      markRepairStarted = resolve
    })
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      async ({ abortSignal }) => {
        markRepairStarted()
        if (!abortSignal) throw new Error("Expected repair to inherit the invocation abort signal")
        return await new Promise<ModelContent | string>((_resolve, reject) => {
          if (abortSignal.aborted) reject(abortSignal.reason)
          else abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })
        })
      },
    ])
    const result = runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, {
      abortSignal: controller.signal,
      prompt: "Search",
    })

    await repairStarted
    controller.abort(stopped)

    await expect(result).rejects.toBe(stopped)
  })

  it.each(["events", "ui-message-stream"] as const)("aborts pending tool-call repair when the %s consumer cancels", async (output) => {
    let markRepairStarted!: () => void
    const repairStarted = new Promise<void>((resolve) => { markRepairStarted = resolve })
    let repairAbortReason: unknown
    const fakeModel = streamingRepairModel()
    fakeModel.doGenerate.mockImplementation(async (options?: ModelCall) => {
      const abortSignal = options?.abortSignal
      markRepairStarted()
      if (!abortSignal) throw new Error("Expected repair to inherit stream cancellation")
      return await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          repairAbortReason = abortSignal.reason
          reject(abortSignal.reason)
        }
        if (abortSignal.aborted) abort()
        else abortSignal.addEventListener("abort", abort, { once: true })
      })
    })
    const result = await streamAgentInline(
      toolCallingAgent(fakeModel, vi.fn(() => "found")),
      runtime,
      { prompt: "Search" },
      output === "events" ? undefined : { output },
    )

    if (output === "ui-message-stream") {
      // SAFETY: UI-message output is a ReadableStream under the selected output contract.
      const reader = (result as ReadableStream<unknown>).getReader()
      const consumption = (async () => {
        while (!(await reader.read()).done) {}
      })().catch(() => undefined)
      await repairStarted
      await reader.cancel()
      await consumption
    }
    else {
      // SAFETY: events output implements the documented async iterable result contract.
      const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      const consumption = (async () => {
        while (!(await iterator.next()).done) {}
      })().catch(() => undefined)
      await repairStarted
      await iterator.return?.()
      await consumption
    }

    expect(repairAbortReason).toMatchObject({ name: "AbortError" })
  })

  it("propagates operational failures from tool-call repair", async () => {
    const unavailable = new Error("repair provider unavailable")
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      async () => { throw unavailable },
    ])

    await expect(runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, { prompt: "Search" })).rejects.toBe(unavailable)
  })

  it("propagates tool-call repair failures after a successful follow-up step", async () => {
    const unavailable = new Error("repair provider unavailable")
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      async () => { throw unavailable },
      "Finished",
    ])

    await expect(runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, { prompt: "Search" })).rejects.toBe(unavailable)
  })

  it("reports completed tool-call repair usage when a later model step fails", async () => {
    const unavailable = new Error("follow-up provider unavailable")
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "{\"query\":\"fixed\"}",
      async () => { throw unavailable },
    ])
    const doGenerate = fakeModel.doGenerate.bind(fakeModel)
    fakeModel.doGenerate = async (options) => ({
      ...await doGenerate(options),
      providerMetadata: { test: { usage: { cost: fakeModel.calls.length / 10 } } },
    })
    const agentError = vi.fn()
    const agent = defineAgent({
      capabilities: [defineCapability({
        id: "search-test",
        tools: {
          search: {
            execute: () => "found",
            inputSchema: toolInputSchema,
            name: "search",
          },
        },
      })],
      driver: {
        // SAFETY: The fake model implements the AI SDK model contract exercised by this test.
        model: fakeModel as never,
      },
      hooks: { "agent:error": agentError },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Search" })).rejects.toBe(unavailable)

    expect(agentError).toHaveBeenCalledWith(expect.objectContaining({
      error: unavailable,
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.3" }),
          usage: expect.objectContaining({ totalTokens: 4 }),
        }),
      }),
    }))
  })

  it("propagates streamed tool-call repair failures after a successful follow-up step", async () => {
    const unavailable = new Error("repair provider unavailable")
    const fakeModel = streamingRepairModel()
    fakeModel.doGenerate.mockRejectedValueOnce(unavailable)
    const result = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, { prompt: "Search" })

    await expect(async () => {
      // SAFETY: streamAgentInline returns the documented async iterable result contract.
      for await (const _event of result as AsyncIterable<unknown>) {}
    }).rejects.toBe(unavailable)
  })

  it("includes tool-call repair usage in streamed invocations", async () => {
    const executions = vi.fn(() => "found")
    const fakeModel = streamingRepairModel()
    const finish = vi.fn()
    const agent = toolCallingAgent(fakeModel, executions, undefined, finish)

    const result = await streamAgentInline(agent, runtime, { prompt: "Search" })
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    const earlyUsage = (result as { usage: Promise<unknown> }).usage
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fakeModel.pullCount).toBe(0)
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) {}

    expect(executions).toHaveBeenCalledWith({ query: "fixed" }, expect.anything())
    expect(fakeModel.doGenerate).toHaveBeenCalledOnce()
    expect(fakeModel.doStream).toHaveBeenCalledTimes(2)
    await expect(earlyUsage).resolves.toMatchObject({ totalTokens: 6 })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.4" }),
          usage: expect.objectContaining({ totalTokens: 6 }),
        }),
      }),
    }))
  })

  it("settles usage when only textStream is consumed", async () => {
    const fakeModel = streamingRepairModel()
    const result = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, { prompt: "Search" })
    // SAFETY: streamAgentInline preserves the AI SDK textStream and usage result members.
    const streamed = result as { textStream: AsyncIterable<unknown>, usage: Promise<unknown> }

    for await (const _text of streamed.textStream) {}

    await expect(streamed.usage).resolves.toMatchObject({ totalTokens: 6 })
  })

  it("starts and settles the model stream when usage is awaited first", async () => {
    const result = await rawStreamingResult()
    // SAFETY: streamAgentInline preserves the AI SDK usage result member.
    const streamed = result as { usage: Promise<unknown> }

    await expect(streamed.usage).resolves.toMatchObject({ totalTokens: 2 })
  })

  it.each(["stream", "fullStream", "textStream"] as const)("settles usage after partially consuming %s", async (key) => {
    const result = await rawStreamingResult()
    // SAFETY: streamAgentInline preserves the selected AI SDK stream and usage result members.
    const streamed = result as Record<typeof key, AsyncIterable<unknown>> & { usage: Promise<unknown> }
    const iterator = streamed[key][Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false })
    await expect(streamed.usage).resolves.toMatchObject({ totalTokens: 2 })
    await expect(iterator.next()).resolves.toMatchObject({ done: key === "textStream" })
    await iterator.return?.()
  })

  it("settles usage requested during the first pending stream read", async () => {
    let releaseFirstEvent!: () => void
    let markFirstEventRequested!: () => void
    const firstEvent = new Promise<void>((resolve) => {
      releaseFirstEvent = resolve
    })
    const firstEventRequested = new Promise<void>((resolve) => {
      markFirstEventRequested = resolve
    })
    const result = await rawStreamingResult(firstEvent, markFirstEventRequested)
    // SAFETY: streamAgentInline preserves the AI SDK stream and usage result members.
    const streamed = result as { stream: AsyncIterable<unknown>, usage: Promise<unknown> }
    const iterator = streamed.stream[Symbol.asyncIterator]()

    const firstRead = iterator.next()
    await firstEventRequested
    const usage = streamed.usage
    releaseFirstEvent()

    const first = await firstRead
    expect(first).toMatchObject({ done: false })
    await expect(usage).resolves.toMatchObject({ totalTokens: 2 })
    const events = [first.value]
    while (true) {
      const item = await iterator.next()
      if (item.done) break
      events.push(item.value)
    }
    // SAFETY: rawStreamingResult exposes the AI SDK's tagged Agent stream event records.
    expect(events.map(event => (event as { type: string }).type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ])
  })

  it.each(["stream", "fullStream", "textStream"] as const)("cancels %s while its usage drain is waiting for a provider event", async (key) => {
    let markFirstEventRequested!: () => void
    const firstEvent = new Promise<void>(() => undefined)
    const firstEventRequested = new Promise<void>((resolve) => { markFirstEventRequested = resolve })
    const cancelled = vi.fn()
    const result = await rawStreamingResult(firstEvent, markFirstEventRequested, cancelled)
    // SAFETY: streamAgentInline preserves the selected AI SDK stream and usage result members.
    const streamed = result as Record<typeof key, ReadableStream<unknown>> & { usage: Promise<unknown> }
    const reader = streamed[key].getReader()

    const firstRead = reader.read()
    await firstEventRequested
    const usage = streamed.usage
    const cancellation = reader.cancel()
    await firstRead.catch(() => undefined)
    await cancellation

    expect(cancelled).toHaveBeenCalledOnce()
    await expect(usage).resolves.toBeUndefined()
  })

  it("settles usage after partially consuming a UI-message stream", async () => {
    const result = await rawStreamingResult()
    // SAFETY: streamAgentInline preserves the AI SDK UI-message method and usage result member.
    const streamed = result as { toUIMessageStream: () => ReadableStream<unknown>, usage: Promise<unknown> }
    const reader = streamed.toUIMessageStream().getReader()

    await expect(reader.read()).resolves.toMatchObject({ done: false })
    await expect(streamed.usage).resolves.toMatchObject({ totalTokens: 2 })
    await expect(reader.read()).resolves.toMatchObject({ done: false })
    await reader.cancel()
  })

  it.each(["stream", "fullStream"] as const)("settles usage when %s stops at its finish chunk", async (key) => {
    const result = await rawStreamingResult()
    // SAFETY: streamAgentInline preserves the selected AI SDK stream and usage result members.
    const streamed = result as Record<typeof key, AsyncIterable<Record<string, unknown>>> & { usage: Promise<unknown> }
    const iterator = streamed[key][Symbol.asyncIterator]()

    while (true) {
      const item = await iterator.next()
      expect(item.done).toBe(false)
      if (item.value?.type === "finish") break
    }

    await expect(streamed.usage).resolves.toMatchObject({ totalTokens: 2 })
  })

  it("settles usage when a UI-message stream stops at its finish chunk", async () => {
    const result = await rawStreamingResult()
    // SAFETY: streamAgentInline preserves the AI SDK UI-message method and usage result member.
    const streamed = result as { toUIMessageStream: () => ReadableStream<Record<string, unknown>>, usage: Promise<unknown> }
    const reader = streamed.toUIMessageStream().getReader()

    while (true) {
      const item = await reader.read()
      expect(item.done).toBe(false)
      if (item.value?.type === "finish") break
    }

    await expect(streamed.usage).resolves.toMatchObject({ totalTokens: 2 })
  })

  it("cancels an unconsumed model stream and settles early usage", async () => {
    const controller = new AbortController()
    const fakeModel = streamingRepairModel()
    const result = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), runtime, {
      abortSignal: controller.signal,
      prompt: "Search",
    })
    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    const earlyUsage = (result as { usage: Promise<unknown> }).usage

    controller.abort(new DOMException("stop", "AbortError"))

    await expect(earlyUsage).resolves.toBeUndefined()
    await vi.waitFor(() => expect(fakeModel.cancelCount).toBe(1))
    expect(fakeModel.pullCount).toBe(0)
  })

  it("handles provider startup rejection while cancelling an unconsumed stream", async () => {
    const controller = new AbortController()
    const stopped = new DOMException("stop", "AbortError")
    const doStream = vi.fn(async ({ abortSignal }: ModelCall) => {
      abortSignal?.throwIfAborted()
      throw new Error("Expected the invocation to be aborted before provider startup")
    })
    const fakeModel = {
      ...model([]),
      doStream,
    }
    await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), runtime, {
      abortSignal: controller.signal,
      prompt: "Search",
    })

    controller.abort(stopped)

    await vi.waitFor(() => expect(doStream).toHaveBeenCalledOnce())
  })

  it("removes the invocation abort listener after stream completion", async () => {
    const controller = new AbortController()
    const addEventListener = vi.spyOn(controller.signal, "addEventListener")
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener")
    const result = await streamAgentInline(toolCallingAgent(streamingRepairModel(), vi.fn(() => "found")), runtime, {
      abortSignal: controller.signal,
      prompt: "Search",
    })

    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) {}

    const abortListeners = addEventListener.mock.calls
      .filter(([type]) => type === "abort")
      .map(([, listener]) => listener)
    expect(abortListeners.length).toBeGreaterThan(0)
    expect(abortListeners.every(listener => removeEventListener.mock.calls.some(([type, removed]) => type === "abort" && removed === listener))).toBe(true)
  })

  it("stops structured materialization when the event consumer returns", async () => {
    const fakeModel = streamingRepairModel()
    const result = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), runtime, { prompt: "Search" })

    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) break

    const pullCount = fakeModel.pullCount
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fakeModel.pullCount).toBe(pullCount)
  })

  it("settles an unstarted UI-message stream when the consumer cancels", async () => {
    let cancelCount = 0
    const finish = vi.fn()
    const fakeModel = {
      ...model([]),
      async doStream() {
        return {
          stream: new ReadableStream({
            cancel() {
              cancelCount += 1
            },
          }, { highWaterMark: 0 }),
        }
      },
    }
    const stream = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(), undefined, finish), runtime, { prompt: "Respond" }, { output: "ui-message-stream" })
    // SAFETY: UI-message output is a ReadableStream under the selected output contract.
    const reader = (stream as ReadableStream<unknown>).getReader()

    await reader.cancel()

    expect(cancelCount).toBe(1)
    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce())
  })

  it("cancels structured materialization when the UI-message consumer returns", async () => {
    let cancelCount = 0
    const fakeModel = {
      ...model([]),
      async doStream() {
        return {
          stream: new ReadableStream({
            cancel() {
              cancelCount += 1
            },
            pull() {
              // Keep the first provider read pending until the caller cancels.
            },
          }, { highWaterMark: 0 }),
        }
      },
    }
    const stream = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), runtime, { prompt: "Search" }, { output: "ui-message-stream" })
    // SAFETY: UI-message output is a ReadableStream under the selected output contract.
    const reader = (stream as ReadableStream<unknown>).getReader()

    await reader.read()
    await reader.cancel()

    await vi.waitFor(() => expect(cancelCount).toBe(1))
  })

  it("cancels traced structured materialization when the UI-message consumer returns", async () => {
    let cancelCount = 0
    const fakeModel = {
      ...model([]),
      async doStream() {
        return {
          stream: new ReadableStream({
            cancel() {
              cancelCount += 1
            },
            pull() {
              // Keep the first provider read pending until the caller cancels.
            },
          }, { highWaterMark: 0 }),
        }
      },
    }
    // SAFETY: This fixture implements the trace log methods exercised by streamAgentInline.
    const traceLog = {
      append: vi.fn(async event => event),
      entries: () => [],
    } as never
    const stream = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), {
      ...runtime,
      traceLog,
    }, { prompt: "Search" }, { output: "ui-message-stream" })
    // SAFETY: UI-message output is a ReadableStream under the selected output contract.
    const reader = (stream as ReadableStream<unknown>).getReader()

    await reader.read()
    await reader.cancel()

    await vi.waitFor(() => expect(cancelCount).toBe(1))
  })

  it("includes tool-call repair usage in UI-message streamed invocations", async () => {
    const fakeModel = streamingRepairModel()
    const finish = vi.fn()
    const agent = toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, finish)

    const stream = await streamAgentInline(agent, runtime, { prompt: "Search" }, { output: "ui-message-stream" })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fakeModel.pullCount).toBe(0)
    // SAFETY: UI-message stream output implements the documented async iterable result contract.
    for await (const _event of stream as AsyncIterable<unknown>) {}

    expect(finish).toHaveBeenCalledWith(expect.objectContaining({
      invocation: expect.objectContaining({
        usage: expect.objectContaining({
          calls: [
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ],
          cost: expect.objectContaining({ usd: "0.4" }),
          usage: expect.objectContaining({ totalTokens: 6 }),
        }),
      }),
    }))
  })

  it("allows tool-call repair to be disabled", async () => {
    const executions = vi.fn(() => "found")
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "Could not call the tool",
    ])

    const result = await runAgentInline(toolCallingAgent(fakeModel, executions, false), runtime, { prompt: "Search" })

    expect(result).toMatchObject({ text: "Could not call the tool" })
    expect(executions).not.toHaveBeenCalled()
    expect(fakeModel.calls).toHaveLength(2)
  })

  it("does not guess unknown tool names during repair", async () => {
    const executions = vi.fn(() => "found")
    const fakeModel = model([
      [{ input: "{\"query\":\"users\"}", toolCallId: "call-1", toolName: "unknown_search", type: "tool-call" }],
      "Unknown tool",
    ])

    const result = await runAgentInline(toolCallingAgent(fakeModel, executions), runtime, { prompt: "Search" })

    expect(result).toMatchObject({ text: "Unknown tool" })
    expect(executions).not.toHaveBeenCalled()
    expect(fakeModel.calls).toHaveLength(2)
    expect(fakeModel.calls.some(call => call.responseFormat)).toBe(false)
  })
})
