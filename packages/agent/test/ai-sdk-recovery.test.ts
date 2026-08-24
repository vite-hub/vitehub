import { describe, expect, it, vi } from "vitest"
import { is, object, string } from "valibot"

import { defineAgent, defineCapability, runAgentInline } from "../src/index.ts"

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

function model(responses: Array<ModelContent | string>) {
  const calls: Array<{ prompt: unknown, responseFormat?: unknown }> = []
  return {
    calls,
    async doGenerate(options: { prompt: unknown, responseFormat?: unknown }) {
      calls.push(options)
      const response = responses[calls.length - 1]
      if (response === undefined) throw new Error("Unexpected model call")
      return {
        content: is(stringSchema, response) ? [{ text: response, type: "text" }] : response,
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

function toolCallingAgent(fakeModel: ReturnType<typeof model>, execute: (input: unknown) => string, repairToolCall?: boolean) {
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
