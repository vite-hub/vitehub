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
    const deliveryUsage = vi.fn()
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "usage-context-check",
          output(context) {
            context.delivery.finishEffect((context) => {
              deliveryUsage(context.usage, context.event.usage)
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
    const usage = finish.mock.calls[0]![0].usage
    expect(usage).toMatchObject({
      run: {
        messageId: "message-1",
        runId: "run-1",
        threadId: "thread-1",
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    })
    expect(deliveryUsage).toHaveBeenCalledWith(usage, usage)
  })

  it("exposes streamed usage on finish context", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()

    const agent = defineAgent({
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
    expect(finish.mock.calls[0]![0].usage).toMatchObject({
      run: {
        messageId: "message-1",
        runId: "run-1",
        threadId: "thread-1",
      },
      usage: { totalTokens: 3 },
    })
  })
})
