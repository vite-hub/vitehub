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

  it("uses root model metadata when response only has an id", async () => {
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
        modelId: "openai/gpt-test",
        response: { id: "response-1" },
        text: "ok",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
        },
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      usageRecord: {
        cost: { amount: "0.000002" },
        model: { id: "openai/gpt-test" },
      },
    })
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
      summary: expect.stringMatching(/^Review run cost about \$0\.00015 using openai\/gpt-test in \d+\.\ds at \d+\.\d tok\/s \(1,250 tokens: 1,000 in \/ 250 out\)\.$/),
    })
  })

  it("exposes usage summaries through output extensions", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
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
          summary: { subject: "Review run" },
        }),
        defineCapability({
          id: "usage-footer",
          output(context) {
            context.output.render((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{
                summary?: string
                usageRecord?: { usage?: { totalTokens?: number } }
              }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                extensionTokens: usage?.usageRecord?.usage?.totalTokens,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
          },
        }),
      ],
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
      extensionTokens: 1250,
      text: "ok\nReview run cost about $0.00015 using openai/gpt-test (1,250 tokens: 1,000 in / 250 out).",
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        totalTokens: 1250,
      },
      usageRecord: {
        usage: {
          inputTokens: 1000,
          outputTokens: 250,
          totalTokens: 1250,
        },
      },
    })
    expect(onUsage).toHaveBeenCalledTimes(1)
  })

  it("preserves usage telemetry when later renderers wrap text output", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [
        usageTelemetry(),
        defineCapability({
          id: "summary-output",
          output(context) {
            context.output.render((result) => {
              const text = typeof result === "object" && result !== null && "text" in result
                ? (result as { text?: unknown }).text
                : result

              return {
                raw: text,
                text,
              }
            })
          },
        }),
      ],
      run: () => ({
        text: "ok",
        totalUsage: {
          inputTokens: 8,
          outputTokens: 2,
          totalTokens: 10,
        },
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      raw: "ok",
      text: "ok",
      usage: {
        inputTokens: 8,
        outputTokens: 2,
        totalTokens: 10,
      },
      usageRecord: {
        usage: {
          inputTokens: 8,
          outputTokens: 2,
          totalTokens: 10,
        },
      },
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
        durationMs: 2000,
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
      summary: expect.stringMatching(/^Review run used 1,250 tokens: 1,000 in \/ 250 out in \d+\.\ds at \d+\.\d tok\/s\.$/),
    })
  })

  it("emits usage records from streamed finish chunks", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { streamAgentOutputToEvents } = await import("../src/agent-output.ts")
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    const { defineAgentUsageMetadata } = await import("../src/internal/agent-usage-metadata.ts")
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
      run: () => defineAgentUsageMetadata({
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
      }, { credentialSource: { label: "local Codex", source: "ambient" } }),
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
          credentialSource: {
            label: "local Codex",
            source: "ambient",
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

  it("emits streamed usage from promise-backed stream result usage", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { streamAgentOutputToEvents } = await import("../src/agent-output.ts")
    const { staticModelPricing, usageTelemetry } = await import("../src/capabilities.ts")
    let resolveUsage: (usage: unknown) => void
    const usage = new Promise(resolve => {
      resolveUsage = resolve
    })

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
        fullStream: (async function* () {
          yield { text: "ok", type: "text-delta" }
          yield { finishReason: "stop", type: "finish" }
          resolveUsage({
            inputTokens: 10,
            outputTokenDetails: { reasoningTokens: 3 },
            outputTokens: 7,
            totalTokens: 17,
          })
        })(),
        modelId: "openai/gpt-test",
        usage,
      }),
    })

    const output = await streamAgent(agent, runtime(), {})
    const events = await Promise.race([
      (async () => {
        const items: unknown[] = []
        for await (const event of streamAgentOutputToEvents(output)) {
          items.push(event)
        }
        return items
      })(),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 100)),
    ])

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          cost: {
            amount: "0.0000024",
            currency: "USD",
            estimated: true,
            source: "custom",
          },
          model: {
            id: "openai/gpt-test",
          },
          usage: {
            inputTokens: 10,
            outputTokenDetails: { reasoningTokens: 3 },
            outputTokens: 7,
            totalTokens: 17,
          },
        }),
      },
      { reason: "stop", type: "finish" },
    ])
    expect(output).toMatchObject({
      usageRecord: {
        usage: {
          inputTokens: 10,
          outputTokenDetails: { reasoningTokens: 3 },
          outputTokens: 7,
          totalTokens: 17,
        },
      },
    })
  })

  it("emits ToolLoopAgent stream result usage when chunks only contain finish", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      isStepCount: () => () => false,
      ToolLoopAgent: class {
        async stream() {
          return {
            fullStream: (async function* () {
              yield { text: "ok", type: "text-delta" }
              yield { finishReason: "stop", type: "finish" }
            })(),
            usage: Promise.resolve({
              inputTokens: 10,
              outputTokenDetails: { reasoningTokens: 3 },
              outputTokens: 7,
              totalTokens: 17,
            }),
          }
        }
      },
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")

      const agent = defineAgent({
        model: {} as never,
      })
      const output = await streamAgent(agent, runtime(), {})
      const events: unknown[] = []
      for await (const event of output as AsyncIterable<unknown>) {
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
        { reason: "stop", type: "finish" },
      ])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("emits ToolLoopAgent onEnd usage when the stream result omits usage", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      isStepCount: () => () => false,
      ToolLoopAgent: class {
        async stream(options: { onEnd?: (event: unknown) => unknown }) {
          return {
            fullStream: (async function* () {
              yield { text: "ok", type: "text-delta" }
              yield { finishReason: "stop", type: "finish" }
              await options.onEnd?.({
                totalUsage: {
                  inputTokens: 10,
                  outputTokenDetails: { reasoningTokens: 3 },
                  outputTokens: 7,
                  totalTokens: 17,
                },
              })
            })(),
          }
        }
      },
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")

      const agent = defineAgent({
        model: {} as never,
      })
      const output = await streamAgent(agent, runtime(), {})
      const events: unknown[] = []
      for await (const event of output as AsyncIterable<unknown>) {
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
        { reason: "stop", type: "finish" },
      ])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("emits ToolLoopAgent onStepEnd usage when the stream result omits usage", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      isStepCount: () => () => false,
      ToolLoopAgent: class {
        async stream(options: { onStepEnd?: (event: unknown) => unknown }) {
          return {
            fullStream: (async function* () {
              yield { text: "ok", type: "text-delta" }
              yield { finishReason: "stop", type: "finish" }
              await options.onStepEnd?.({
                usage: {
                  inputTokens: 10,
                  outputTokenDetails: { reasoningTokens: 3 },
                  outputTokens: 7,
                  totalTokens: 17,
                },
              })
            })(),
          }
        }
      },
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")

      const agent = defineAgent({
        model: {} as never,
      })
      const output = await streamAgent(agent, runtime(), {})
      const events: unknown[] = []
      for await (const event of output as AsyncIterable<unknown>) {
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
        { reason: "stop", type: "finish" },
      ])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("emits ToolLoopAgent model call end usage over empty stream result usage", async () => {
    vi.doMock("ai", () => ({
      jsonSchema: vi.fn(schema => schema),
      isStepCount: () => () => false,
      ToolLoopAgent: class {
        async stream(options: { onLanguageModelCallEnd?: (event: unknown) => unknown }) {
          return {
            fullStream: (async function* () {
              yield { text: "ok", type: "text-delta" }
              yield { finishReason: "stop", type: "finish" }
              await options.onLanguageModelCallEnd?.({
                usage: {
                  inputTokens: 10,
                  outputTokenDetails: { reasoningTokens: 3 },
                  outputTokens: 7,
                  totalTokens: 17,
                },
              })
            })(),
            usage: Promise.resolve({}),
          }
        }
      },
    }))

    try {
      const { defineAgent, streamAgent } = await import("../src/index.ts")

      const agent = defineAgent({
        model: {} as never,
      })
      const output = await streamAgent(agent, runtime(), {})
      const events: unknown[] = []
      for await (const event of output as AsyncIterable<unknown>) {
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
        { reason: "stop", type: "finish" },
      ])
    }
    finally {
      vi.doUnmock("ai")
    }
  })

  it("emits streamed usage from outer usage when the stream has no finish chunk", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { streamAgentOutputToEvents } = await import("../src/agent-output.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [
        usageTelemetry(),
      ],
      run: () => ({
        fullStream: (async function* () {
          yield { text: "ok", type: "text-delta" }
        })(),
        usage: Promise.resolve({
          inputTokens: 10,
          outputTokenDetails: { reasoningTokens: 3 },
          outputTokens: 7,
          totalTokens: 17,
        }),
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
          usage: {
            inputTokens: 10,
            outputTokenDetails: { reasoningTokens: 3 },
            outputTokens: 7,
            totalTokens: 17,
          },
        }),
      },
      { type: "finish" },
    ])
  })

  it("preserves usage on stream result objects that are also async iterable", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")

    class StreamResult {
      fullStream = (async function* () {
        yield { text: "ok", type: "text-delta" }
        yield { finishReason: "stop", type: "finish" }
      })()

      usage = Promise.resolve({
        inputTokens: 10,
        outputTokenDetails: { reasoningTokens: 3 },
        outputTokens: 7,
        totalTokens: 17,
      })

      async *[Symbol.asyncIterator]() {
        yield { text: "wrong", type: "text-delta" }
      }
    }

    const agent = defineAgent({
      capabilities: [
        usageTelemetry(),
      ],
      run: () => new StreamResult(),
    })

    const output = await streamAgent(agent, runtime(), {})
    const events: unknown[] = []
    for await (const event of output as AsyncIterable<unknown>) {
      events.push(event)
    }

    expect(events).toEqual([
      { text: "ok", type: "text-delta" },
      {
        type: "usage",
        usageRecord: expect.objectContaining({
          usage: {
            inputTokens: 10,
            outputTokenDetails: { reasoningTokens: 3 },
            outputTokens: 7,
            totalTokens: 17,
          },
        }),
      },
      { reason: "stop", type: "finish" },
    ])
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

  it("summarizes non-token usage without cost or token counts", async () => {
    const { defineAgent, defineCapability, runAgent } = await import("../src/index.ts")
    const { usageTelemetry } = await import("../src/capabilities.ts")

    const agent = defineAgent({
      capabilities: [
        usageTelemetry({
          summary: { subject: "Harness run" },
        }),
        defineCapability({
          id: "usage-note",
          output(context) {
            context.output.render((result, renderContext) => {
              const usage = renderContext.output.extensions.get<{ summary?: string }>("usage-telemetry")
              return {
                ...result as Record<string, unknown>,
                text: `${(result as { text?: string }).text}\n${usage?.summary}`,
              }
            })
          },
        }),
      ],
      run: () => ({
        text: "ok",
        usage: {
          actions: 2,
          sessions: 1,
        },
      }),
    })

    await expect(runAgent(agent, runtime(), {})).resolves.toMatchObject({
      text: "ok\nHarness run reported actions: 2, sessions: 1.",
      usageRecord: {
        usage: {
          details: {
            actions: 2,
            sessions: 1,
          },
        },
      },
    })
  })

  it("loads Vercel AI Gateway pricing from the models endpoint", async () => {
    const { vercelAiGatewayPricing } = await import("../src/capabilities.ts")
    const fetch = vi.fn(async () => Response.json({
      data: [
        {
          id: "anthropic/claude-opus-4.8",
          pricing: {
            input: "0.000005",
            output: "0.000025",
          },
        },
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
    await expect(pricing({
      model: { id: "claude-opus-4-8", provider: "googleVertex.anthropic.messages" },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
      },
    })).resolves.toEqual({
      amount: "0.000175",
      currency: "USD",
      estimated: true,
      source: "vercel-ai-gateway",
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
