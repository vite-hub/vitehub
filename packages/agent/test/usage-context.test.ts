import { describe, expect, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  run: {
    messageId: "message-1",
    runId: "run-1",
    threadId: "thread-1",
  },
  runtime: "unknown" as const,
  waitUntil: vi.fn(),
})

describe("usage context", () => {
  it("exposes normalized usage on finish and delivery context", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const deliveryUsage = vi.fn()
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry(),
        defineCapability({
          id: "usage-context-check",
          output(context) {
            context.delivery.finishEffect((context) => {
              deliveryUsage(context.extensions.get("usage-telemetry"), context.event.extensions.get("usage-telemetry"))
              return false
            })
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
        finishReason: "stop",
        response: {
          id: "response-1",
          modelId: "openai/gpt-test",
          timestamp: "2026-05-21T00:00:00.000Z",
        },
        text: "ok",
        totalUsage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      }), },
    })

    const result = await runAgent(agent, runtime(), {})

    expect(result).toMatchObject({ text: "ok" })
    expect(finish).toHaveBeenCalledTimes(1)
    const usage = finish.mock.calls[0]![0].extensions.get("usage-telemetry")
    expect(usage).toMatchObject({
      inputTokens: 10,
      messageId: "message-1",
      modelId: "openai/gpt-test",
      outputTokens: 5,
      responseFinishReason: "stop",
      responseId: "response-1",
      responseTimestamp: "2026-05-21T00:00:00.000Z",
      runId: "run-1",
      threadId: "thread-1",
      totalTokens: 15,
    })
    expect(deliveryUsage).toHaveBeenCalledWith(usage, usage)
  })

  it("exposes streamed usage on finish context", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [usageTelemetry()],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
        stream: (async function* () {
          yield { text: "ok", type: "text-delta" }
          yield { type: "usage", usageRecord: { usage: { totalTokens: 3 } } }
          yield { finishReason: "stop", type: "finish" }
        })(),
      }), },
    })

    const stream = await streamAgent(agent, runtime(), {}) as AsyncIterable<unknown>
    const events: unknown[] = []
    for await (const event of stream) events.push(event)

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      { type: "usage", usageRecord: { usage: { totalTokens: 3 } } },
      { reason: "stop", type: "finish" },
    ])
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toMatchObject({
      messageId: "message-1",
      runId: "run-1",
      threadId: "thread-1",
      totalTokens: 3,
    })
  })
})
