import { describe, expect, it } from "vitest"

import {
  streamAgentOutputToEvents,
  toAgentRunResult,
  toAgentStreamEvent,
} from "../src/agent-output.ts"

describe("agent output helpers", () => {
  it("normalizes primitive values into Agent run results", () => {
    expect(toAgentRunResult("ok")).toEqual({ raw: "ok", text: "ok" })
    expect(toAgentRunResult(42)).toEqual({ raw: 42, text: undefined })
  })

  it("normalizes model output objects into Agent run results", () => {
    const value = { finishReason: "stop", text: "ok", usage: { inputTokens: 1 }, warnings: [] }

    expect(toAgentRunResult(value)).toEqual({
      finishReason: "stop",
      raw: value,
      text: "ok",
      usage: { inputTokens: 1 },
      usageRecord: undefined,
      warnings: [],
    })
  })

  it("normalizes AI SDK v6 output objects into Agent run results", () => {
    const value = {
      _output: "ok from output",
      finishReason: "stop",
      steps: [{ text: "older" }],
      usage: { inputTokens: 1 },
    }

    expect(toAgentRunResult(value)).toEqual({
      finishReason: "stop",
      raw: value,
      text: "ok from output",
      usage: { inputTokens: 1 },
      usageRecord: undefined,
      warnings: undefined,
    })
  })

  it("falls back to the latest step text for AI SDK result objects", () => {
    const value = {
      finishReason: "stop",
      steps: [{ text: "older" }, { text: "latest" }],
    }

    expect(toAgentRunResult(value).text).toBe("latest")
  })

  it("falls back to AI SDK v7 step content text", () => {
    const value = {
      finishReason: "stop",
      steps: [
        { content: [{ text: "older", type: "text" }] },
        {
          content: [
            { output: { ok: true }, toolCallId: "call-1", toolName: "lookup", type: "tool-result" },
            { text: "latest", type: "text" },
            { textDelta: " result", type: "text-delta" },
          ],
        },
      ],
    }

    expect(toAgentRunResult(value).text).toBe("latest result")
  })

  it("tracks tool names across stream events", () => {
    const toolNames = new Map<string, string>()

    expect(toAgentStreamEvent({ id: "call-1", toolName: "confirm", type: "tool-input-start" }, toolNames)).toEqual({
      id: "call-1",
      input: undefined,
      name: "confirm",
      type: "tool-input-start",
    })
    expect(toAgentStreamEvent({ output: "accepted", toolCallId: "call-1", type: "tool-result" }, toolNames)).toEqual({
      error: undefined,
      id: "call-1",
      name: "confirm",
      output: "accepted",
      type: "tool-result",
    })
    expect(toAgentStreamEvent({ input: false, toolCallId: "call-1", toolName: "confirm", type: "tool-input-available" }, toolNames)).toEqual({
      id: "call-1",
      input: false,
      name: "confirm",
      type: "tool-call",
    })
    expect(toAgentStreamEvent({ duration: 42, output: 0, toolCallId: "call-1", type: "tool-output-available" }, toolNames)).toEqual({
      durationMs: 42,
      error: undefined,
      id: "call-1",
      name: "confirm",
      output: 0,
      type: "tool-result",
    })
  })

  it("normalizes AI SDK stream aliases", () => {
    expect(toAgentStreamEvent({ textDelta: "x", type: "text" })).toEqual({
      id: undefined,
      text: "x",
      type: "text-delta",
    })
    expect(toAgentStreamEvent({ args: { ok: true }, toolCallId: "call-1", toolName: "confirm", type: "tool-call" })).toEqual({
      id: "call-1",
      input: { ok: true },
      name: "confirm",
      type: "tool-call",
    })
  })

  it("normalizes stream error chunks", () => {
    expect(toAgentStreamEvent({ error: new Error("boom"), type: "error" })).toEqual({
      error: "boom",
      type: "error",
    })
  })

  it("keeps approval events when converting normalized streams", async () => {
    const output = (async function* () {
      yield { id: "approval-1", input: { command: "write" }, messageId: "message-1", name: "workspace_write", reason: "Needs approval.", type: "approval-request" }
      yield { approved: true, decidedAt: "2026-01-01T00:00:00.000Z", id: "approval-1", messageId: "message-1", reason: "Allowed.", type: "approval-decision" }
    })()

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: "approval-1", input: { command: "write" }, messageId: "message-1", name: "workspace_write", reason: "Needs approval.", type: "approval-request" },
      { approved: true, decidedAt: "2026-01-01T00:00:00.000Z", id: "approval-1", messageId: "message-1", reason: "Allowed.", type: "approval-decision" },
      { type: "finish" },
    ])
  })

  it("converts text outputs into stream events", async () => {
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents({ finishReason: "stop", text: "ok" })) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("adds a terminal finish event to raw async iterable output", async () => {
    const output = (async function* () {
      yield { text: "ok", type: "text-delta" }
    })()

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: undefined, text: "ok", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("does not duplicate an existing raw async iterable finish event", async () => {
    const output = (async function* () {
      yield { text: "ok", type: "text-delta" }
      yield { finishReason: "stop", type: "finish" }
    })()

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("converts AI SDK v6 output objects into stream events", async () => {
    const usageRecord = { usage: { totalTokens: 1 } }
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents({ _output: "ok from output", finishReason: "stop", usageRecord })) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok from output", type: "text-delta" },
      { type: "usage", usageRecord },
      { reason: "stop", type: "finish" },
    ])
  })

  it("emits usage from raw results wrapped by text output renderers", async () => {
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents({
      raw: {
        usage: Promise.resolve({
          inputTokens: 10,
          outputTokenDetails: { reasoningTokens: 3 },
          outputTokens: 7,
          totalTokens: 17,
        }),
      },
      text: "ok",
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          usage: {
            inputTokens: 10,
            outputTokenDetails: { reasoningTokens: 3 },
            outputTokens: 7,
            totalTokens: 17,
          },
        },
      },
      { type: "finish" },
    ])
  })

  it("includes model metadata in derived raw-result usage records", async () => {
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents({
      raw: {
        durationMs: 1000,
        provider: "googleVertex.anthropic.messages",
        response: {
          id: "resp_1",
          modelId: "claude-opus-4-8",
          timestamp: "2026-06-22T20:00:00.000Z",
        },
        usage: Promise.resolve({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
      },
      text: "ok",
    })) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          model: {
            id: "claude-opus-4-8",
            provider: "googleVertex.anthropic.messages",
          },
          response: {
            id: "resp_1",
            timestamp: "2026-06-22T20:00:00.000Z",
          },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      },
      { type: "finish" },
    ])
  })

  it("adds a terminal finish event to fullStream output", async () => {
    const output = {
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: undefined, text: "ok", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("prefers stream over deprecated fullStream and async iterable result surfaces", async () => {
    class StreamResult {
      stream = (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield { finishReason: "stop", type: "finish" }
      })()

      fullStream = (async function* () {
        yield { text: "wrong-full-stream", type: "text-delta" }
      })()

      usage = Promise.resolve({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
      })

      async *[Symbol.asyncIterator]() {
        yield { text: "wrong", type: "text-delta" }
      }
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(new StreamResult())) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          usage: {
            inputTokens: 8,
            outputTokens: 2,
            totalTokens: 10,
          },
        },
      },
      { reason: "stop", type: "finish" },
    ])
  })

  it("falls back to textStream when event streams have no visible text", async () => {
    const output = {
      stream: (async function* () {
        yield { finishReason: "stop", type: "finish" }
      })(),
      textStream: (async function* () {
        yield "ok"
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("keeps visible event stream text before falling back to textStream", async () => {
    const output = {
      stream: (async function* () {
        yield { delta: "ok", type: "text-delta" }
        yield { finishReason: "stop", type: "finish" }
      })(),
      textStream: (async function* () {
        yield undefined
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { id: undefined, text: "ok", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("emits usage from AI SDK finish-step chunks before finish", async () => {
    const output = {
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          type: "finish-step",
          usage: {
            inputTokens: 4,
            outputTokenDetails: {
              reasoningTokens: 2,
            },
            outputTokens: 1,
            totalTokens: 5,
          },
        }
        yield {
          totalUsage: {
            inputTokens: 16,
            outputTokens: 4,
            totalTokens: 20,
          },
          type: "finish",
        }
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          usage: {
            inputTokens: 16,
            outputTokens: 4,
            totalTokens: 20,
          },
        },
      },
      { type: "finish" },
    ])
  })

  it("inherits model metadata from stream result usage records", async () => {
    const output = {
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          totalUsage: {
            inputTokens: 16,
            outputTokens: 4,
            totalTokens: 20,
          },
          type: "finish",
        }
      })(),
      modelId: "claude-opus-4-8",
      provider: "googleVertex.anthropic.messages",
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          model: {
            id: "claude-opus-4-8",
            provider: "googleVertex.anthropic.messages",
          },
          usage: {
            inputTokens: 16,
            outputTokens: 4,
            totalTokens: 20,
          },
        },
      },
      { type: "finish" },
    ])
  })

  it("preserves non-token stream usage details", async () => {
    const output = {
      fullStream: (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          type: "finish",
          usage: {
            actions: 2,
            sessions: 1,
            wallTimeMs: 800,
          },
        }
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          usage: {
            details: {
              actions: 2,
              sessions: 1,
              wallTimeMs: 800,
            },
          },
        },
      },
      { type: "finish" },
    ])
  })

  it("adds a terminal finish event to textStream output", async () => {
    const output = {
      textStream: (async function* () {
        yield "a"
        yield "b"
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "a", type: "text-delta" },
      { text: "b", type: "text-delta" },
      { type: "finish" },
    ])
  })

  it("emits usage from promise-backed textStream results", async () => {
    const output = {
      textStream: (async function* () {
        yield "ok"
      })(),
      usage: Promise.resolve({
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
      }),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: {
          usage: {
            inputTokens: 8,
            outputTokens: 2,
            totalTokens: 10,
          },
        },
      },
      { type: "finish" },
    ])
  })

  it("reads fullStream getters once while converting stream events", async () => {
    let reads = 0
    const output = {
      get fullStream() {
        reads++
        return (async function* () {
          yield { text: "ok", type: "text-delta" }
          yield { finishReason: "stop", type: "finish" }
        })()
      },
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(reads).toBe(1)
    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })
})
