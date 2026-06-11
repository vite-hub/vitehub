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

  it("tracks tool names across stream events", () => {
    const toolNames = new Map<string, string>()

    expect(toAgentStreamEvent({ input: false, toolCallId: "call-1", toolName: "confirm", type: "tool-input-available" }, toolNames)).toEqual({
      id: "call-1",
      input: false,
      name: "confirm",
      type: "tool-call",
    })
    expect(toAgentStreamEvent({ output: 0, toolCallId: "call-1", type: "tool-output-available" }, toolNames)).toEqual({
      error: undefined,
      id: "call-1",
      name: "confirm",
      output: 0,
      type: "tool-result",
    })
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
