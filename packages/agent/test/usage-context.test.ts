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
              deliveryUsage(context.invocation.usage, context.event.invocation.usage)
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
    const usage = finish.mock.calls[0]![0].invocation.usage
    expect(usage).toMatchObject({
      model: "openai/gpt-test",
      response: {
        finishReason: "stop",
        id: "response-1",
        timestamp: "2026-05-21T00:00:00.000Z",
      },
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
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      run: {
        messageId: "message-1",
        runId: "run-1",
        threadId: "thread-1",
      },
      usage: { totalTokens: 3 },
    })
  })

  it("preserves driver usage when output rendering replaces the result", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        defineCapability({
          id: "replace-output",
          output(context) {
            context.output.render(() => "rendered")
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
        text: "driver",
        usage: {
          inputTokens: 7,
          outputTokens: 2,
        },
      }), },
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toBe("rendered")

    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      usage: {
        inputTokens: 7,
        outputTokens: 2,
        totalTokens: 9,
      },
    })
  })

  it("preserves async event usage before UI message stream conversion", async () => {
    const { readUIMessageStream } = await import("ai")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          providerMetadata: { openrouter: { usage: { cost: 0.00123 } } },
          type: "usage",
          usageRecord: { usage: { totalTokens: 4 } },
        }
        yield { type: "finish" }
      })(), },
    })

    const stream = await streamAgent(agent, runtime(), {}, { output: "ui-message-stream" }) as ReadableStream<never>
    for await (const _message of readUIMessageStream({ stream })) {}

    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      cost: {
        display: "$0.00123",
        estimated: false,
        source: "provider",
        usd: "0.00123",
      },
      usage: { totalTokens: 4 },
    })
  })

  it("exposes non-token usage details in the invocation record", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      hooks: {
        "agent:finish": finish,
      },
      driver: { run: () => ({
        text: "ok",
        usage: {
          actions: 3,
          sessions: 1,
        },
      }), },
    })

    await runAgent(agent, runtime(), {})

    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      usage: {
        details: {
          actions: 3,
          sessions: 1,
        },
      },
    })
  })
})
