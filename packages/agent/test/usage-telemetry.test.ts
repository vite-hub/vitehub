import { describe, expect, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  run: {
    messageId: "message-1",
    runId: "run-1",
    threadId: "thread-1",
  },
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("usage telemetry", () => {
  it("normalizes usage and attaches a priced usage record", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
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
      }),
    })

    const result = await runAgent(agent, runtime(), {})

    expect(result).toMatchObject({
      finishReason: "stop",
      text: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      usageRecord: {
        cost: {
          amount: "0.000002",
          currency: "USD",
          estimated: true,
          source: "custom",
        },
        model: {
          id: "openai/gpt-test",
        },
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
      },
    })
    expect(finish).toHaveBeenCalledTimes(1)
    const usageRecord = (result as { usageRecord?: unknown }).usageRecord
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toEqual(usageRecord)
  })

  it("summarizes usage telemetry for finish hooks", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
          summary: { subject: "Review run" },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
        response: {
          modelId: "openai/gpt-test",
        },
        text: "ok",
        totalUsage: {
          inputTokens: 1000,
          outputTokens: 250,
        },
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        usage: {
          inputTokens: 1000,
          outputTokens: 250,
          totalTokens: 1250,
        },
      },
    })
    expect(finish).toHaveBeenCalledTimes(1)
    const usageRecord = finish.mock.calls[0]![0].extensions.get("usage-telemetry")
    expect(usageRecord).toMatchObject({
      latency: {
        durationMs: expect.any(Number),
      },
      summary: expect.stringMatching(/^Review run cost about \$0\.00015 using openai\/gpt-test in \d+\.\ds \(1,250 tokens: 1,000 in \/ 250 out\)\.$/),
    })
  })

  it("uses app-owned usage summary formatting", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          summary: {
            format: record => `Summary: ${record.usage?.outputTokens} output tokens at ${record.latency?.tokensPerSecond?.toFixed(1)} tokens/sec`,
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
        text: "ok",
        totalUsage: {
          outputTokens: 20,
        },
        durationMs: 2000,
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({ text: "ok" })
    expect(finish).toHaveBeenCalledTimes(1)
    const usageRecord = finish.mock.calls[0]![0].extensions.get("usage-telemetry")
    expect(usageRecord).toMatchObject({
      summary: "Summary: 20 output tokens at 10.0 tokens/sec",
    })
  })

  it("summarizes partial token splits without rendering missing counts as zero", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          summary: { subject: "Review run" },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
        text: "ok",
        totalUsage: {
          inputTokens: 1000,
          totalTokens: 1250,
        },
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        usage: {
          inputTokens: 1000,
          totalTokens: 1250,
        },
      },
    })
    expect(finish).toHaveBeenCalledTimes(1)
    const usageRecord = finish.mock.calls[0]![0].extensions.get("usage-telemetry")
    expect(usageRecord).toMatchObject({
      summary: expect.stringMatching(/^Review run used 1,250 tokens: 1,000 in \/ 250 out in \d+\.\ds\.$/),
    })
  })

  it("emits usage records from streamed finish chunks", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { streamAgentOutputToEvents } = await import("../src/agent-output.ts")
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const onUsage = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          onUsage,
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
        }),
      ],
      run: () => ({
        fullStream: (async function* () {
          yield { text: "ok", type: "text-delta" }
          yield {
            finishReason: "stop",
            response: {
              id: "response-1",
              modelId: "openai/gpt-test",
              timestamp: "2026-05-21T00:00:00.000Z",
            },
            totalUsage: {
              inputTokens: 10,
              outputTokens: 5,
            },
            type: "finish",
          }
        })(),
      }),
    })

    const output = await streamAgent(agent, runtime(), {})
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          cost: {
            amount: "0.000002",
            currency: "USD",
            estimated: true,
            source: "custom",
          },
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        }),
      },
      { reason: "stop", type: "finish" },
    ])
    expect(output).toMatchObject({
      usageRecord: {
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    })
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    }), {
      run: {
        messageId: "message-1",
        runId: "run-1",
        threadId: "thread-1",
      },
    })
  })

  it("records streamed usage when ui-message-stream consumes result.stream", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()
    const onUsage = vi.fn()

    class StreamResult {
      fullStream = (async function* () {
        yield { text: "wrong", type: "text-delta" }
        yield {
          finishReason: "stop",
          totalUsage: {
            inputTokens: 1,
            outputTokens: 2,
          },
          type: "finish",
        }
      })()

      stream = (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          finishReason: "stop",
          totalUsage: {
            inputTokens: 4,
            outputTokens: 6,
          },
          type: "finish",
        }
      })()

      toUIMessageStream() {
        const stream = this.stream
        return new ReadableStream({
          async start(controller) {
            for await (const chunk of stream) {
              controller.enqueue(chunk)
            }
            controller.close()
          },
        })
      }
    }

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({ onUsage }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => new StreamResult(),
    })

    const stream = await streamAgent(agent, runtime(), {}, { output: "ui-message-stream" }) as ReadableStream<unknown>
    const reader = stream.getReader()
    const chunks: unknown[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }

    expect(chunks).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          usage: {
            inputTokens: 4,
            outputTokens: 6,
            totalTokens: 10,
          },
        }),
      },
      {
        finishReason: "stop",
        totalUsage: {
          inputTokens: 4,
          outputTokens: 6,
        },
        type: "finish",
      },
    ])
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    }), {
      run: {
        messageId: "message-1",
        runId: "run-1",
        threadId: "thread-1",
      },
    })
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toEqual(expect.objectContaining({
      usage: {
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    }))
  })

  it("attaches streamed usage telemetry to results with getter-only usage properties", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { streamAgentOutputToEvents } = await import("../src/agent-output.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")

    class GetterOnlyUsageResult {
      fullStream = (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield {
          finishReason: "stop",
          totalUsage: {
            inputTokens: 2,
            outputTokens: 3,
          },
          type: "finish",
        }
      })()

      get usage() {
        return undefined
      }
    }

    const agent = defineAgent({
      capabilities: [
        usageTelemetry(),
      ],
      run: () => new GetterOnlyUsageResult(),
    })

    const output = await streamAgent(agent, runtime(), {})
    const events: unknown[] = []
    for await (const event of streamAgentOutputToEvents(output)) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            totalTokens: 5,
          },
        }),
      },
      { reason: "stop", type: "finish" },
    ])
    expect(output).toMatchObject({
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      },
      usageRecord: {
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        },
      },
    })
  })

  it("does not fail the invocation when pricing fails", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          pricing: () => {
            throw new Error("pricing unavailable")
          },
        }),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
        text: "ok",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
        },
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "ok",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
      usageRecord: {
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
      },
    })
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toEqual(expect.objectContaining({
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
      },
    }))
  })

  it("does not add a usage telemetry extension when no usage record is produced", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")
    const finish = vi.fn()

    const agent = defineAgent({
      capabilities: [
        usageTelemetry(),
      ],
      hooks: {
        "agent:finish": finish,
      },
      run: () => ({
        text: "ok",
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "ok",
    })
    expect(finish).toHaveBeenCalledTimes(1)
    expect(finish.mock.calls[0]![0].extensions.get("usage-telemetry")).toBeUndefined()
  })

  it("preserves non-token usage details without inventing token cost", async () => {
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          pricing: staticModelPricing({
            "openai/gpt-test": {
              input: "0.00000010",
              output: "0.00000020",
            },
          }),
        }),
      ],
      run: () => ({
        response: {
          modelId: "openai/gpt-test",
        },
        text: "ok",
        usage: {
          actions: 2,
          sessions: 1,
          wallTimeMs: 800,
        },
      }),
    })

    const result = await runAgent(agent, runtime(), {})
    expect(result).toMatchObject({
      text: "ok",
      usage: {
        details: {
          actions: 2,
          sessions: 1,
          wallTimeMs: 800,
        },
      },
      usageRecord: {
        usage: {
          details: {
            actions: 2,
            sessions: 1,
            wallTimeMs: 800,
          },
        },
      },
    })
    expect((result as { usageRecord?: { cost?: unknown } }).usageRecord?.cost).toBeUndefined()
  })

  it("loads Vercel AI Gateway pricing from the models endpoint", async () => {
    const { vercelAiGatewayPricing } = await import("../src/capabilities.ts")
    const fetch = vi.fn(async () => Response.json({
      data: [
        {
          id: "openai/gpt-test",
          pricing: {
            input: "0.00000010",
            output: "0.00000020",
          },
        },
      ],
    }))
    const pricing = vercelAiGatewayPricing({ fetch })

    await expect(pricing({
      model: { id: "openai/gpt-test" },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    })).resolves.toEqual({
      amount: "0.000002",
      currency: "USD",
      estimated: true,
      source: "vercel-ai-gateway",
    })
    await expect(pricing({
      model: { id: "openai/gpt-test" },
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    })).resolves.toMatchObject({ amount: "0.0000003" })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
