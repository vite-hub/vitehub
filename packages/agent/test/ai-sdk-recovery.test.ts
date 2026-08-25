import { describe, expect, it, vi } from "vitest"
import { array, is, object, string } from "valibot"

import { defineAgent, defineCapability, runAgentInline, streamAgentInline } from "../src/index.ts"

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

  it("repairs invalid structured output from streamed invocations", async () => {
    let releaseRepair!: () => void
    const repairReleased = new Promise<void>((resolve) => { releaseRepair = resolve })
    const fakeModel = model([async () => {
      await repairReleased
      return "{\"text\":\"repaired\"}"
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
    await expect(earlyUsage).resolves.toMatchObject({ totalTokens: 4 })
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
          calls: expect.arrayContaining([
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ]),
          cost: expect.objectContaining({ usd: "0.3" }),
          usage: expect.objectContaining({ totalTokens: 6 }),
        }),
      }),
    }))
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

  it("cancels structured materialization when the event consumer returns", async () => {
    const fakeModel = streamingRepairModel()
    const result = await streamAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found"), undefined, undefined, true), runtime, { prompt: "Search" })

    // SAFETY: streamAgentInline returns the documented async iterable result contract.
    for await (const _event of result as AsyncIterable<unknown>) break

    await vi.waitFor(() => expect(fakeModel.cancelCount).toBe(1))
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
          calls: expect.arrayContaining([
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.1" }) }),
            expect.objectContaining({ cost: expect.objectContaining({ usd: "0.2" }) }),
          ]),
          cost: expect.objectContaining({ usd: "0.3" }),
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
