import { describe, expect, it, vi } from "vitest"
import { defineDiagnostics } from "nostics"
import { normalizeRuntimeDiagnosticError } from "@vite-hub/runtime"

import { defineAgent, defineCapability, runAgentInline, streamAgentInline } from "../src/index.ts"
import { hasRuntimeType, isRuntimeRecord } from "../src/internal/runtime-type.ts"
import { isAsyncIterable } from "../src/internal/stream-result.ts"

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
      return isRuntimeRecord(value) && hasRuntimeType(value.text, "string")
        ? { value: { text: value.text } }
        : { issues: [{ message: "Expected text to be a string" }] }
    },
    vendor: "vitehub-test",
    version: 1 as const,
  },
}

type ModelContent = Array<Record<string, unknown>>
type ModelOptions = { abortSignal?: AbortSignal, prompt: unknown, responseFormat?: unknown }
type ModelResponse = ModelContent | string | ((options: ModelOptions) => Promise<ModelContent | string>)

function model(responses: ModelResponse[]) {
  const calls: ModelOptions[] = []
  return {
    calls,
    async doGenerate(options: ModelOptions) {
      calls.push(options)
      const response = responses[calls.length - 1]
      if (response === undefined) throw new Error("Unexpected model call")
      const resolved = hasRuntimeType(response, "function") ? await response(options) : response
      return {
        content: hasRuntimeType(resolved, "string") ? [{ text: resolved, type: "text" }] : resolved,
        finishReason: { raw: "stop", unified: "stop" },
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
          outputTokens: { reasoning: 0, text: 1, total: 1 },
        },
        warnings: [],
      }
    },
    async doStream(options: ModelOptions) {
      const result = await this.doGenerate(options)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            for (const part of result.content) {
              if (part.type === "text") {
                controller.enqueue({ type: "text-start", id: "text-1" })
                controller.enqueue({ type: "text-delta", id: "text-1", delta: part.text })
                controller.enqueue({ type: "text-end", id: "text-1" })
              }
              else controller.enqueue(part)
            }
            controller.enqueue({ type: "finish", finishReason: result.finishReason, usage: result.usage })
            controller.close()
          },
        }),
      }
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
      return isRuntimeRecord(value) && hasRuntimeType(value.query, "string")
        ? { value: { query: value.query } }
        : { issues: [{ message: "Expected query to be a string" }] }
    },
    vendor: "vitehub-test",
    version: 1 as const,
  },
}

function languageModel(fakeModel: ReturnType<typeof model>) {
  // SAFETY: This test double implements the AI SDK language model methods exercised by Agent generation.
  return fakeModel as never
}

function textResult(result: unknown): { text: string } {
  if (!isRuntimeRecord(result) || !hasRuntimeType(result.text, "string")) {
    throw new TypeError("Expected a text Agent result")
  }
  return { text: result.text }
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
      model: languageModel(fakeModel),
    },
    runtime: false,
  })
}

describe("AI SDK recovery", () => {
  it.each(["instance", "serialized", "normalized"].flatMap(form => ["generate", "stream"].map(mode => ({ form, mode }))))("includes $form diagnostic guidance in the next $mode model call", async ({ form, mode }) => {
    const diagnostics = defineDiagnostics({
      codes: {
        SEARCH_INDEX_MISSING: {
          why: "Search index is missing.",
          fix: "Create the search index before searching.",
          docs: "https://example.com/search",
        },
      },
    })
    const fakeModel = model([
      [{ input: '{"query":"vitehub"}', toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      async (options) => {
        const prompt = JSON.stringify(options.prompt)
        expect(prompt).toContain("SEARCH_INDEX_MISSING")
        expect(prompt).toContain("Create the search index before searching.")
        expect(prompt).toContain("https://example.com/search")
        expect(prompt).not.toContain("private provider response")
        expect(prompt).not.toContain("private stack")
        return "Create the search index first."
      },
    ])
    const failure = diagnostics.SEARCH_INDEX_MISSING({ cause: { token: "private provider response" } })
    failure.stack = "private stack"
    const thrown: unknown = form === "serialized"
      ? JSON.parse(JSON.stringify(failure))
      : form === "normalized"
        ? normalizeRuntimeDiagnosticError(failure, { includeStack: true })
        : failure
    const agent = toolCallingAgent(fakeModel, () => { throw thrown })
    if (mode === "stream") {
      const result = await streamAgentInline(agent, runtime, { prompt: "Search" })
      if (!isAsyncIterable(result)) throw new TypeError("Expected an Agent event stream")
      const events: unknown[] = []
      for await (const event of result) events.push(event)
      expect(JSON.stringify(events)).toContain("Create the search index first.")
    }
    else {
      const result = textResult(await runAgentInline(agent, runtime, { prompt: "Search" }))
      expect(result.text).toBe("Create the search index first.")
    }
    expect(fakeModel.calls).toHaveLength(2)
    expect(failure.message).toBe("Search index is missing.")
  })

  it("repairs structured output with three total attempts by default", async () => {
    const fakeModel = model(["{\"text\":1}", "{\"text\":2}", "{\"text\":\"repaired\"}"])
    const agent = defineAgent({
      driver: { model: languageModel(fakeModel), output: { schema: outputSchema } },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).resolves.toEqual({ text: "repaired" })
    expect(fakeModel.calls).toHaveLength(3)
  })

  it("allows structured-output repair to be disabled", async () => {
    const fakeModel = model(["{\"text\":1}", "{\"text\":\"must not run\"}"])
    const agent = defineAgent({
      driver: { model: languageModel(fakeModel), output: { maxAttempts: 1, schema: outputSchema } },
      runtime: false,
    })

    await expect(runAgentInline(agent, runtime, { prompt: "Respond" })).rejects.toMatchObject({ code: "AGENT_OUTPUT_SCHEMA_INVALID" })
    expect(fakeModel.calls).toHaveLength(1)
  })

  it("rejects invalid structured-output attempt limits", async () => {
    const fakeModel = model(["{\"text\":\"unused\"}"])
    const agent = defineAgent({
      driver: { model: languageModel(fakeModel), output: { maxAttempts: 0, schema: outputSchema } },
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

    const result = textResult(await runAgentInline(toolCallingAgent(fakeModel, executions), runtime, { prompt: "Search" }))

    expect(result.text).toBe("Finished")
    expect(executions).toHaveBeenCalledWith({ query: "fixed" }, expect.anything())
    expect(fakeModel.calls).toHaveLength(3)
    expect(fakeModel.calls[1]?.responseFormat).toBeDefined()
  })

  it("cancels a pending tool-call repair with its invocation", async () => {
    const abort = new AbortController()
    const abortError = new Error("Invocation cancelled")
    let markRepairStarted = () => {}
    const repairStarted = new Promise<void>((resolve) => {
      markRepairStarted = resolve
    })
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      async ({ abortSignal }) => {
        markRepairStarted()
        if (!abortSignal) throw new Error("Expected repair call to receive an abort signal")
        return await new Promise((_resolve, reject) => {
          if (abortSignal.aborted) reject(abortSignal.reason)
          else abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })
        })
      },
    ])

    const invocation = runAgentInline(toolCallingAgent(fakeModel, vi.fn(() => "found")), runtime, {
      abortSignal: abort.signal,
      prompt: "Search",
    })
    await repairStarted
    abort.abort(abortError)

    await expect(invocation).rejects.toBe(abortError)
    expect(fakeModel.calls).toHaveLength(2)
  })

  it("allows tool-call repair to be disabled", async () => {
    const executions = vi.fn(() => "found")
    const fakeModel = model([
      [{ input: "{\"query\":1}", toolCallId: "call-1", toolName: "search", type: "tool-call" }],
      "Could not call the tool",
    ])

    const result = textResult(await runAgentInline(toolCallingAgent(fakeModel, executions, false), runtime, { prompt: "Search" }))

    expect(result.text).toBe("Could not call the tool")
    expect(executions).not.toHaveBeenCalled()
    expect(fakeModel.calls).toHaveLength(2)
  })

  it("does not guess unknown tool names during repair", async () => {
    const executions = vi.fn(() => "found")
    const fakeModel = model([
      [{ input: "{\"query\":\"users\"}", toolCallId: "call-1", toolName: "unknown_search", type: "tool-call" }],
      "Unknown tool",
    ])

    const result = textResult(await runAgentInline(toolCallingAgent(fakeModel, executions), runtime, { prompt: "Search" }))

    expect(result.text).toBe("Unknown tool")
    expect(executions).not.toHaveBeenCalled()
    expect(fakeModel.calls).toHaveLength(2)
    expect(fakeModel.calls.some(call => call.responseFormat)).toBe(false)
  })
})
