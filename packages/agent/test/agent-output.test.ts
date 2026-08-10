import { describe, expect, it } from "vitest"

import { applyStreamEvent } from "../src/messages.ts"
import { finalChannelOutputSelectedSymbol } from "../src/internal/final-channel-output.ts"
import { synthesizedAgentOutputSymbol } from "../src/internal/synthesized-agent-output.ts"
import {
  finalTextFromAgentOutput,
  streamAgentOutputToEvents,
  toAgentRunResult,
  toAgentStreamEvent,
  usageRecordFromStreamChunk,
} from "../src/agent-output.ts"

describe("agent output helpers", () => {
  it("normalizes primitive values into Agent run results", () => {
    expect(toAgentRunResult("ok")).toEqual({ raw: "ok", text: "ok" })
    expect(toAgentRunResult(42)).toEqual({ raw: 42, text: undefined })
  })

  it("preserves raw metadata with text selected for a final-only Channel", () => {
    const raw = {
      artifacts: [{ path: "result.txt", url: "https://example.com/result.txt" }],
      content: [{ text: "progress", type: "text" }],
      finishReason: "tool-calls",
      usage: { inputTokens: 1 },
      warnings: ["warning"],
    }
    const value = { modelId: "rendered-model", raw, text: "" }
    Object.assign(value, { warnings: ["rendered warning"] })
    Object.defineProperty(value, finalChannelOutputSelectedSymbol, { value: true })
    expect(toAgentRunResult(value)).toMatchObject({
      artifacts: raw.artifacts,
      finishReason: "tool-calls",
      raw,
      text: "",
      usageRecord: { model: "rendered-model", usage: { inputTokens: 1 } },
      warnings: ["rendered warning"],
    })
  })

  it("normalizes model output objects into Agent run results", () => {
    const value = { finishReason: "stop", text: "ok", usage: { inputTokens: 1 }, warnings: [] }

    expect(toAgentRunResult(value)).toEqual({
      finishReason: "stop",
      raw: value,
      text: "ok",
      usage: { inputTokens: 1 },
      usageRecord: {
        usage: { inputTokens: 1 },
      },
      warnings: [],
    })
  })

  it("separates Gateway transport from canonical model identity", () => {
    expect(toAgentRunResult({
      modelId: "zai/glm-5v-turbo",
      provider: "gateway",
      usage: { inputTokens: 1 },
    }).usageRecord).toEqual({
      model: "zai/glm-5v-turbo",
      transport: "gateway",
      usage: { inputTokens: 1 },
    })
  })

  it.each(["claude-custom", "gemini-custom"])("does not infer a vendor from the %s model name", (modelId) => {
    expect(toAgentRunResult({
      modelId,
      provider: "custom-provider",
      usage: { inputTokens: 1 },
    }).usageRecord?.model).toBe(`custom-provider/${modelId}`)
  })

  it("normalizes provider-reported cost with canonical precedence", () => {
    const usage = { inputTokens: 1 }
    const providerMetadata = (cost: unknown) => ({ openrouter: { usage: { cost } } })

    expect(toAgentRunResult({
      providerMetadata: providerMetadata(0.00123),
      usage,
    }).usageRecord?.cost).toEqual({
      display: "$0.00123",
      estimated: false,
      source: "provider",
      usd: "0.00123",
    })

    expect(toAgentRunResult({ providerMetadata: providerMetadata(5e-21), usage }).usageRecord?.cost?.usd)
      .toBe("0.000000000000000000005")

    for (const cost of [-1, -0, Number.NaN, Number.POSITIVE_INFINITY, "0.00123"]) {
      expect(toAgentRunResult({ providerMetadata: providerMetadata(cost), usage }).usageRecord?.cost).toBeUndefined()
    }

    const canonicalCost = {
      display: "$0.02",
      estimated: false,
      source: "custom" as const,
      usd: "0.02",
    }
    expect(toAgentRunResult({
      providerMetadata: providerMetadata(0.00123),
      usageRecord: { cost: canonicalCost, usage },
    }).usageRecord?.cost).toEqual(canonicalCost)

    const raw = { providerMetadata: providerMetadata(0.02), usage }
    const selected = { providerMetadata: providerMetadata(0.00123), raw }
    Object.defineProperty(selected, finalChannelOutputSelectedSymbol, { value: true })
    expect(toAgentRunResult(selected).usageRecord?.cost?.usd).toBe("0.00123")

    expect(usageRecordFromStreamChunk({
      providerMetadata: providerMetadata(0.00123),
      type: "usage",
      usageRecord: { usage },
    })?.cost?.usd).toBe("0.00123")
  })

  it("preserves provider-reported cost through streamed usage events and promised metadata", async () => {
    const providerMetadata = { openrouter: { usage: { cost: 0.00123 } } }
    const stream = async function* () {
      yield {
        providerMetadata,
        type: "usage",
        usageRecord: { usage: { inputTokens: 1 } },
      }
    }

    const events = []
    for await (const event of streamAgentOutputToEvents({
      providerMetadata: Promise.resolve(providerMetadata),
      stream: stream(),
      usage: Promise.resolve({ inputTokens: 1 }),
    })) events.push(event)

    expect(events).toContainEqual({
      type: "usage",
      usageRecord: {
        cost: {
          display: "$0.00123",
          estimated: false,
          source: "provider",
          usd: "0.00123",
        },
        usage: { inputTokens: 1 },
      },
    })

    const fallbackEvents = []
    for await (const event of streamAgentOutputToEvents({
      providerMetadata: Promise.resolve(providerMetadata),
      stream: (async function* () {})(),
      usage: Promise.resolve({ inputTokens: 1 }),
    })) fallbackEvents.push(event)
    expect(fallbackEvents).toContainEqual(expect.objectContaining({
      type: "usage",
      usageRecord: expect.objectContaining({ cost: expect.objectContaining({ usd: "0.00123" }) }),
    }))
  })

  it("preserves published delivery artifacts in Agent run results", () => {
    const value = {
      artifacts: [{
        alt: "Preview",
        mediaType: "image/png",
        path: "artifacts/preview.png",
        placement: "inline",
        url: "https://assets.example/preview.png",
      }, { path: 42 }],
      text: "done",
    }

    expect(toAgentRunResult(value).artifacts).toEqual([{
      alt: "Preview",
      mediaType: "image/png",
      path: "artifacts/preview.png",
      placement: "inline",
      url: "https://assets.example/preview.png",
    }])
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
      usageRecord: {
        usage: { inputTokens: 1 },
      },
      warnings: undefined,
    })
  })

  it("falls back to output fields when result text is empty", () => {
    expect(toAgentRunResult({
      _output: "structured fallback",
      output: "output fallback",
      text: "",
    }).text).toBe("output fallback")

    expect(toAgentRunResult({
      _output: "structured fallback",
      text: "",
    }).text).toBe("structured fallback")
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

  it("falls back to top-level content text for AI SDK result objects", () => {
    const value = {
      content: [
        { text: "final", type: "text" },
        { textDelta: " result", type: "text-delta" },
      ],
      finishReason: "stop",
    }

    expect(toAgentRunResult(value).text).toBe("final result")
  })

  it("selects final assistant text after harness tool boundaries", () => {
    const raw = {
      steps: [{
        content: [
          { text: "I'll inspect the image.", type: "text" },
          { input: { path: "image.png" }, toolCallId: "call-1", toolName: "view_image", type: "tool-call" },
          { output: { ok: true }, toolCallId: "call-1", toolName: "view_image", type: "tool-result" },
          { text: "The image shows ", type: "text" },
          { textDelta: "a dental X-ray.", type: "text-delta" },
        ],
      }],
    }

    expect(finalTextFromAgentOutput({ raw, text: "I'll inspect the image.The image shows a dental X-ray." }))
      .toBe("The image shows a dental X-ray.")
  })

  it("keeps only text after the last of multiple harness tools", () => {
    expect(finalTextFromAgentOutput({
      steps: [
        {
          content: [
            { text: "First check.", type: "text" },
            { toolCallId: "call-1", toolName: "search", type: "tool-call" },
            { toolCallId: "call-1", toolName: "search", type: "tool-result" },
          ],
        },
        {
          content: [
            { text: "Second check.", type: "text" },
            { toolCallId: "call-2", toolName: "read", type: "tool-call" },
            { toolCallId: "call-2", toolName: "read", type: "tool-result" },
          ],
        },
        {
          content: [
            { text: "Final answer.", type: "text" },
          ],
        },
      ],
    })).toBe("Final answer.")
  })

  it("selects final text from a later step text field", () => {
    expect(finalTextFromAgentOutput({
      steps: [
        {
          content: [
            { text: "Checking.", type: "text" },
            { toolCallId: "call-1", toolName: "search", type: "tool-call" },
            { toolCallId: "call-1", toolName: "search", type: "tool-result" },
          ],
        },
        {
          content: [{ toolCallId: "call-2", toolName: "format", type: "tool-result" }],
          text: "Final answer.",
        },
      ],
      text: "Checking.Final answer.",
    })).toBe("Final answer.")
  })

  it("keeps wrapper output empty when raw output ends at a tool", () => {
    expect(finalTextFromAgentOutput({
      raw: {
        content: [
          { text: "Checking the workspace.", type: "text" },
          { toolCallId: "call-1", toolName: "workspace", type: "tool-call" },
          { toolCallId: "call-1", toolName: "workspace", type: "tool-result" },
        ],
      },
      text: "Synthesized workspace answer.",
    })).toBe("")
  })

  it("preserves marked synthesized output when raw output ends at a tool", () => {
    const value = {
      raw: {
        content: [
          { text: "Checking the workspace.", type: "text" },
          { toolCallId: "call-1", toolName: "workspace", type: "tool-call" },
          { toolCallId: "call-1", toolName: "workspace", type: "tool-result" },
        ],
      },
      text: "Synthesized workspace answer.",
    }
    Object.defineProperty(value, synthesizedAgentOutputSymbol, { value: true })

    expect(finalTextFromAgentOutput(value)).toBe("Synthesized workspace answer.")
  })

  it("does not restore aggregate commentary when raw output ends at a tool", () => {
    expect(finalTextFromAgentOutput({
      raw: {
        content: [
          { text: "Checking the workspace.", type: "text" },
          { toolCallId: "call-1", toolName: "workspace", type: "tool-call" },
          { toolCallId: "call-1", toolName: "workspace", type: "tool-result" },
        ],
      },
      text: "Checking the workspace.",
    })).toBe("")
  })

  it("falls back to direct final text when structured output ends at a tool", () => {
    expect(finalTextFromAgentOutput({
      content: [
        { text: "Checking the workspace.", type: "text" },
        { toolCallId: "call-1", toolName: "workspace", type: "tool-call" },
        { toolCallId: "call-1", toolName: "workspace", type: "tool-result" },
      ],
      text: "Synthesized workspace answer.",
    })).toBe("Synthesized workspace answer.")
  })

  it("selects raw final text before output rendering", () => {
    const raw = {
      content: [
        { text: "I'll inspect it.", type: "text" },
        { toolCallId: "call-1", toolName: "inspect", type: "tool-call" },
        { toolCallId: "call-1", toolName: "inspect", type: "tool-result" },
        { text: "unsafe <answer>", type: "text" },
      ],
    }

    expect(finalTextFromAgentOutput({ raw, text: "Rendered &lt;answer&gt;" }))
      .toBe("unsafe <answer>")
  })

  it("preserves normal assistant text when no tool runs", () => {
    expect(finalTextFromAgentOutput({
      content: [
        { text: "Normal ", type: "text" },
        { textDelta: "answer.", type: "text-delta" },
      ],
    })).toBe("Normal answer.")
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

  it("preserves explicit text phases across text lifecycle events", () => {
    const textPhases = new Map()

    expect(toAgentStreamEvent({ id: "commentary-1", phase: "commentary", type: "text-start" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ delta: "Checking the image.", id: "commentary-1", type: "text-delta" }, undefined, textPhases)).toEqual({
      id: "commentary-1",
      phase: "commentary",
      text: "Checking the image.",
      type: "text-delta",
    })
    expect(toAgentStreamEvent({ id: "commentary-1", type: "text-end" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ delta: "Unknown text.", id: "commentary-1", type: "text-delta" }, undefined, textPhases)).toEqual({
      id: "commentary-1",
      text: "Unknown text.",
      type: "text-delta",
    })
    expect(toAgentStreamEvent({ phase: "reasoning", text: "Private reasoning.", type: "text" })).toBeUndefined()
    expect(toAgentStreamEvent({ phase: "final_answer", text: "Final answer.", type: "text" })).toEqual({
      id: undefined,
      phase: "final",
      text: "Final answer.",
      type: "text-delta",
    })

    expect(toAgentStreamEvent({ id: "reused", phase: "commentary", type: "text-start" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ id: "reused", type: "text-start" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ id: "reused", text: "Unknown text.", type: "text-delta" }, undefined, textPhases)).toEqual({
      id: "reused",
      text: "Unknown text.",
      type: "text-delta",
    })
    expect(toAgentStreamEvent({ id: "reused", phase: "commentary", type: "text-start" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ id: "reused", phase: "unsupported", text: "Unknown text.", type: "text-delta" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ id: "reused", text: "Still private.", type: "text-delta" }, undefined, textPhases)).toBeUndefined()

    expect(toAgentStreamEvent({ id: "reused", phase: "final", text: "Final answer.", type: "text-delta" }, undefined, textPhases)).toEqual({
      id: "reused",
      phase: "final",
      text: "Final answer.",
      type: "text-delta",
    })
    expect(toAgentStreamEvent({ id: "reused", text: "Final suffix.", type: "text-delta" }, undefined, textPhases)).toEqual({
      id: "reused",
      phase: "final",
      text: "Final suffix.",
      type: "text-delta",
    })

    expect(toAgentStreamEvent({ id: "reasoning-1", phase: "reasoning", type: "text-start" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ delta: "Private reasoning.", id: "reasoning-1", type: "text-delta" }, undefined, textPhases)).toBeUndefined()
    expect(toAgentStreamEvent({ id: "reasoning-1", type: "text-end" }, undefined, textPhases)).toBeUndefined()
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

  it("normalizes native tool approval requests", () => {
    const toolNames = new Map<string, string>()
    expect(toAgentStreamEvent({ input: {}, toolCallId: "call-1", toolName: "github__write", type: "tool-call" }, toolNames)).toMatchObject({ type: "tool-call" })
    expect(toAgentStreamEvent({ approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" }, toolNames)).toEqual({
      id: "approval-1",
      name: "github__write",
      toolCallId: "call-1",
      type: "approval-request",
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

  it("preserves data-prefixed stream events before text and finish", async () => {
    const output = (async function* () {
      yield { data: { title: "Title", type: "title" }, transient: true, type: "data-title" }
      yield { text: "ok", type: "text-delta" }
      yield { finishReason: "stop", type: "finish" }
    })()

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { data: { title: "Title", type: "title" }, id: undefined, transient: true, type: "data-title" },
      { text: "ok", type: "text-delta" },
      { reason: "stop", type: "finish" },
    ])
  })

  it("folds data-prefixed stream events into messages", () => {
    const messages = applyStreamEvent([], {
      data: { title: "Title", type: "title" },
      type: "data-title",
    })

    expect(messages).toEqual([{
      id: expect.any(String),
      parts: [{ data: { title: "Title", type: "title" }, type: "data-title" }],
      role: "assistant",
    }])
  })

  it("does not fold transient data events into messages", () => {
    expect(applyStreamEvent([], {
      data: { progress: 50 },
      transient: true,
      type: "data-progress",
    })).toEqual([])
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
          latency: {
            durationMs: 1000,
          },
          model: "anthropic/claude-opus-4-8",
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

  it.each(["google-compatible", "my-anthropic-proxy"])("preserves custom provider identity %s", async (provider) => {
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents({
      raw: {
        provider,
        response: { modelId: "gemini-custom" },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      text: "ok",
    })) {
      events.push(event)
    }

    expect(events[1]).toMatchObject({
      type: "usage",
      usageRecord: { model: `${provider}/gemini-custom` },
    })
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
      fullStream: (async function* () {
        yield { phase: "upload", type: "file", url: "https://example.com/result.txt" }
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

  it("does not fall back to textStream after explicitly hidden phased text", async () => {
    const output = {
      fullStream: (async function* () {
        yield { id: "reasoning-1", phase: "reasoning", type: "text-start" }
        yield { delta: "Private reasoning.", id: "reasoning-1", type: "text-delta" }
        yield { id: "reasoning-1", type: "text-end" }
      })(),
      textStream: (async function* () {
        yield "Private reasoning."
      })(),
    }

    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([{ type: "finish" }])
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
          model: "anthropic/claude-opus-4-8",
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

  it("emits handled Response body chunks as they arrive", async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"))
        controller.enqueue(new TextEncoder().encode("second"))
        controller.close()
      },
    }))
    const events = []
    for await (const event of streamAgentOutputToEvents(response)) events.push(event)
    expect(events).toEqual([
      { text: "first", type: "text-delta" },
      { text: "second", type: "text-delta" },
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
