import { describe, expect, it, vi } from "vitest"
import { is, object, string } from "valibot"

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
  let streamCall = 0
  const doGenerate = vi.fn(async () => ({
    content: [{ text: "{\"query\":\"fixed\"}", type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    providerMetadata: { test: { usage: { cost: 0.2 } } },
    usage,
    warnings: [],
  }))
  const doStream = vi.fn(async () => {
    streamCall += 1
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] })
          if (streamCall === 1) {
            controller.enqueue({ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" })
            controller.enqueue({ finishReason: { raw: "tool-calls", unified: "tool-calls" }, providerMetadata: { test: { usage: { cost: 0.1 } } }, type: "finish", usage })
          }
          else {
            controller.enqueue({ id: "answer", type: "text-start" })
            controller.enqueue({ delta: "Finished", id: "answer", type: "text-delta" })
            controller.enqueue({ id: "answer", type: "text-end" })
            controller.enqueue({ finishReason: { raw: "stop", unified: "stop" }, providerMetadata: { test: { usage: { cost: 0.1 } } }, type: "finish", usage })
          }
          controller.close()
        },
      }),
    }
  })
  return {
    doGenerate,
    doStream,
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
