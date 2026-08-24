import { afterEach, describe, expect, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("cost Capability", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("enriches canonical usage with cache-aware Vercel AI Gateway cost", async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => Response.json({
      data: [{
        id: "zai/glm-5v-turbo",
        pricing: {
          input: "0.0000012",
          input_cache_read: "0.0000003",
          input_cache_write: "0.0000015",
          output: "0.000004",
        },
      }],
    }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "zai/glm-5v-turbo",
          provider: "gateway",
          text: "ok",
          usage: {
            inputTokenDetails: {
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
            },
            inputTokens: 1_000,
            outputTokens: 50,
            totalTokens: 1_050,
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "log breakfast" })).resolves.toMatchObject({
      text: "ok",
    })

    const event = finish.mock.calls[0]![0]
    expect(event.extensions.get("cost")).toBe(event.invocation.usage)
    expect(event.invocation.usage?.cost).toEqual({
      display: "~$0.00125",
      usd: "0.00125",
      estimated: true,
      source: "vercel-ai-gateway",
    })
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it.each([
    {
      name: "input",
      pricing: { output: "0.000002" },
    },
    {
      name: "output",
      pricing: { input: "0.000001" },
    },
  ])("does not estimate partial cost when $name pricing is missing", async ({ pricing }) => {
    const fetch = vi.fn(async () => Response.json({
      data: [{
        id: "custom/model",
        pricing,
      }],
    }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })

    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    })
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toBeUndefined()
  })

  it.each([
    {
      name: "input",
      usage: { inputTokens: 10 },
    },
    {
      name: "output",
      usage: { outputTokens: 2 },
    },
  ])("does not estimate cost when only $name token usage is reported", async ({ usage }) => {
    const fetch = vi.fn(async () => Response.json({
      data: [{
        id: "custom/model",
        pricing: {
          input: "0.000001",
          output: "0.000002",
        },
      }],
    }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage,
        }),
      },
    })

    // SAFETY: This fixture's Driver returns the runAgent object shape inspected below.
    const result = await runAgent(agent, runtime(), { prompt: "hello" }) as {
      usageRecord?: { cost?: unknown }
    }
    expect(result.usageRecord?.cost).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("supports custom pricing without provider dependencies", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      usd: "0.42",
      estimated: false,
      source: "custom" as const,
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })

    expect(pricing).toHaveBeenCalledWith(expect.objectContaining({
      model: "custom/model",
      usage: expect.objectContaining({ totalTokens: 12 }),
    }))
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toEqual({
      display: "$0.42",
      usd: "0.42",
      estimated: false,
      source: "custom",
    })
  })

  it("adds display to custom USD pricing", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.00125",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        }),
      },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })

    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toEqual({
      display: "~$0.00125",
      estimated: true,
      source: "custom",
      usd: "0.00125",
    })
  })

  it("leaves malformed provider cost metadata best-effort", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const legacyCost = { amount: "0.01", currency: "USD" }
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord: {
            cost: legacyCost,
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          },
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
      usageRecord: { cost: legacyCost },
    })
  })

  it.each([
    { catalogId: "openai/gpt-5", modelId: "gpt-5", provider: "openai.responses" },
    { catalogId: "google/gemini-2.5-pro", modelId: "gemini-2.5-pro", provider: "google.generative-ai" },
  ])("matches $provider catalog entries for unscoped model IDs", async ({ catalogId, modelId, provider }) => {
    const fetch = vi.fn(async () => Response.json({
      data: [{
        id: catalogId,
        pricing: {
          input: "0.000001",
          output: "0.000002",
        },
      }],
    }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId,
          provider,
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      usageRecord: {
        cost: {
          display: "~$0.000014",
          usd: "0.000014",
          estimated: true,
          source: "vercel-ai-gateway",
        },
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("does not map compatible providers to vendor catalog scopes", async () => {
    const fetch = vi.fn(async () => Response.json({
      data: [{
        id: "openai/gpt-5",
        pricing: {
          input: "0.000001",
          output: "0.000002",
        },
      }],
    }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "gpt-5",
          provider: "openai-compatible",
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    const result = await runAgent(agent, runtime(), { prompt: "hello" })

    expect(result).toMatchObject({
      usageRecord: {
        usage: {
          totalTokens: 12,
        },
      },
    })
    expect(result).not.toMatchObject({
      usageRecord: {
        cost: expect.anything(),
      },
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("does not discard an explicit model scope for Anthropic pricing fallback", async () => {
    const fetch = vi.fn(async () => Response.json({
      data: [{
        id: "anthropic/claude-custom",
        pricing: {
          input: "0.000001",
          output: "0.000002",
        },
      }],
    }))
    const { vercelAiGatewayPricing } = await import("../src/capabilities.ts")
    const pricing = vercelAiGatewayPricing({ fetch })

    await expect(pricing({
      model: "custom-provider/claude-custom",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    })).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("enriches canonical usage without requiring a finish hook", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true,
      source: "custom" as const,
    }))
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => ({
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        cost: {
          display: "~$0.02",
          usd: "0.02",
          estimated: true,
          source: "custom",
        },
      },
    })
    expect(pricing).toHaveBeenCalledOnce()
  })

  it("prices usage records before yielding them from streamAgent", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true,
      source: "custom" as const,
    }))
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => (async function* () {
          yield {
            type: "usage" as const,
            usageRecord: {
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
            },
          }
        })(),
      },
    })

    const stream = await streamAgent(agent, runtime(), { prompt: "hello" })
    const events = []
    // SAFETY: streamAgent returns an async iterable for its default output mode.
    for await (const event of stream as AsyncIterable<unknown>) events.push(event)

    expect(events).toEqual([{
      type: "usage",
      usageRecord: {
        cost: {
          display: "~$0.02",
          usd: "0.02",
          estimated: true,
          source: "custom",
        },
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
        },
      },
    }])
    expect(pricing).toHaveBeenCalledOnce()
  })

  it("prices UI message stream usage before tracing it", async () => {
    const { createTraceEventLog } = await import("@vite-hub/runtime")
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => (async function* () {
          yield {
            type: "usage" as const,
            usageRecord: {
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
            },
          }
        })(),
      },
    })

    // SAFETY: The selected UI message output mode returns a readable stream.
    const stream = await streamAgent(agent, {
      ...runtime(),
      traceLog,
    }, { prompt: "hello" }, { output: "ui-message-stream" }) as ReadableStream<unknown>
    for await (const _chunk of stream) {}

    expect(traceLog.entries()).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "usage.hasCost": true,
        "usage.totalTokens": 12,
      }),
      name: "agent.usage.recorded",
    }))
  })

  it("prices toUIMessageStream usage before tracing it", async () => {
    const { createTraceEventLog } = await import("@vite-hub/runtime")
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "usage",
                  usageRecord: {
                    usage: {
                      inputTokens: 10,
                      outputTokens: 2,
                      totalTokens: 12,
                    },
                  },
                })
                controller.close()
              },
            })
          },
        }),
      },
    })

    // SAFETY: The selected UI message output mode returns a readable stream.
    const stream = await streamAgent(agent, {
      ...runtime(),
      traceLog,
    }, { prompt: "hello" }, { output: "ui-message-stream" }) as ReadableStream<unknown>
    for await (const _chunk of stream) {}

    expect(traceLog.entries()).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "usage.hasCost": true,
        "usage.totalTokens": 12,
      }),
      name: "agent.usage.recorded",
    }))
  })

  it("prices distinct preserved UI stream usage before tracing it", async () => {
    const { createTraceEventLog } = await import("@vite-hub/runtime")
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const traceLog = createTraceEventLog()
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          fullStream: (async function* () {
            yield { type: "finish" }
          })(),
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: "usage",
                  usageRecord: {
                    usage: {
                      inputTokens: 10,
                      outputTokens: 2,
                      totalTokens: 12,
                    },
                  },
                })
                controller.close()
              },
            })
          },
        }),
      },
    })

    // SAFETY: This fixture's Driver exposes the UI message stream method inspected below.
    const result = await runAgent(agent, {
      ...runtime(),
      traceLog,
    }, { prompt: "hello" }) as { toUIMessageStream: () => ReadableStream<unknown> }
    for await (const _chunk of result.toUIMessageStream()) {}

    expect(traceLog.entries()).toContainEqual(expect.objectContaining({
      attributes: expect.objectContaining({
        "usage.hasCost": true,
        "usage.totalTokens": 12,
      }),
      name: "agent.usage.recorded",
    }))
  })

  it("prices serialized UI message response usage before returning it", async () => {
    const { readUIMessageStream } = await import("ai")
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const { uiMessageStreamFromResponse } = await import("../src/stream-output.ts")
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true as const,
      source: "custom",
    }))
    const agent = defineAgent({
      capabilities: [cost({
        pricing,
      })],
      driver: {
        run: () => new Response(`data: ${JSON.stringify({
          type: "usage",
          usageRecord: {
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
          },
        })}\n\n`, {
          headers: { "x-vercel-ai-ui-message-stream": "v1" },
        }),
      },
    })

    // SAFETY: The selected UI message output mode returns a Response.
    const response = await streamAgent(agent, runtime(), { prompt: "hello" }, {
      output: "ui-message-stream",
    }) as Response
    // SAFETY: The synthetic streaming response has a byte body, which the AI SDK reader accepts after conversion.
    for await (const _message of readUIMessageStream({ stream: uiMessageStreamFromResponse(response as Response & { body: ReadableStream<Uint8Array> }) as ReadableStream<never> })) {}
    expect(pricing).toHaveBeenCalledOnce()
  })

  it.each([
    { hybrid: false, kind: "plain" },
    { hybrid: true, kind: "hybrid" },
  ])("prices native response usage after a renderer returns a $kind async iterable", async ({ hybrid }) => {
    const { readUIMessageStream } = await import("ai")
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, defineCapability, streamAgent } = await import("../src/index.ts")
    const { uiMessageStreamFromResponse } = await import("../src/stream-output.ts")
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true as const,
      source: "custom",
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [
        cost({
          pricing,
        }),
        defineCapability({
          id: "iterable-response-renderer",
          output(context) {
            context.output.render((result) => {
              // SAFETY: The fixture Driver result exposes the UI message stream method rendered here.
              const stream = (result as { toUIMessageStream: () => ReadableStream<unknown> }).toUIMessageStream()
              if (hybrid) {
                return {
                  async *[Symbol.asyncIterator]() {
                    yield { text: "generic", type: "text-delta" }
                  },
                  toUIMessageStream: () => stream,
                }
              }
              return (async function* () {
                for await (const chunk of stream) yield chunk
              })()
            })
          },
        }),
      ],
      driver: {
        run: () => new Response([
          { messageId: "message-1", type: "start" },
          { id: "text-1", type: "text-start" },
          { delta: "native", id: "text-1", type: "text-delta" },
          {
            type: "usage",
            usageRecord: {
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
            },
          },
          { id: "text-1", type: "text-end" },
          { finishReason: "stop", type: "finish" },
        ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "x-vercel-ai-ui-message-stream": "v1" },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    // SAFETY: The selected UI message output mode returns a Response.
    const response = await streamAgent(agent, runtime(), { prompt: "hello" }, {
      output: "ui-message-stream",
    }) as Response

    const messages = []
    // SAFETY: The synthetic streaming response has a byte body, which the AI SDK reader accepts after conversion.
    for await (const message of readUIMessageStream({ stream: uiMessageStreamFromResponse(response as Response & { body: ReadableStream<Uint8Array> }) as ReadableStream<never> })) {
      messages.push(message)
    }
    expect(messages.at(-1)?.parts).toContainEqual(expect.objectContaining({ text: "native", type: "text" }))
    expect(JSON.stringify(messages)).not.toContain("generic")
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toMatchObject({
      display: "~$0.02",
      usd: "0.02",
    })
    expect(pricing).toHaveBeenCalledOnce()
  })

  it("returns stream results before their usage promise settles", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    let resolveUsage!: (usage: { totalTokens: number }) => void
    const usage = new Promise<{ totalTokens: number }>((resolve) => {
      resolveUsage = resolve
    })
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" }
          })(),
          usage,
        }),
      },
    })

    const pending = streamAgent(agent, runtime(), { prompt: "hello" })
    const outcome = await Promise.race([
      pending.then(() => "returned"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])
    resolveUsage({ totalTokens: 1 })

    expect(outcome).toBe("returned")
    const stream = await pending
    // SAFETY: streamAgent returns an async iterable for its default output mode.
    for await (const _chunk of stream as AsyncIterable<unknown>) {}
  })

  it("returns runAgent stream results before their usage promise settles", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    let resolveUsage!: (usage: { totalTokens: number }) => void
    const usage = new Promise<{ totalTokens: number }>((resolve) => {
      resolveUsage = resolve
    })
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" }
          })(),
          usage,
        }),
      },
    })

    const pending = runAgent(agent, runtime(), { prompt: "hello" })
    const outcome = await Promise.race([
      pending.then(() => "returned"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])
    resolveUsage({ totalTokens: 1 })

    expect(outcome).toBe("returned")
    // SAFETY: This fixture's pending runAgent value exposes its Driver stream result.
    const result = await pending as { stream: AsyncIterable<unknown> }
    for await (const _chunk of result.stream) {}
  })

  it("does not await unresolved result usage when a runAgent stream is closed early", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const usage = new Promise(() => {})
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" }
            await new Promise(() => {})
          })(),
          usage,
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    // SAFETY: This fixture's runAgent result exposes its Driver stream.
    const result = await runAgent(agent, runtime(), { prompt: "hello" }) as { stream: AsyncIterable<unknown> }
    const consume = (async () => {
      for await (const _chunk of result.stream) break
    })()

    await expect(Promise.race([
      consume.then(() => "closed"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("closed")
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toBeUndefined()
  })

  it("attaches deferred usage to returned plain stream results", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    let resolveUsage!: (usage: { inputTokens: number, outputTokens: number, totalTokens: number }) => void
    const usage = new Promise<{ inputTokens: number, outputTokens: number, totalTokens: number }>((resolve) => {
      resolveUsage = resolve
    })
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" }
            resolveUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
          })(),
          usage,
        }),
      },
    })

    // SAFETY: This fixture's runAgent result exposes its Driver stream and deferred usage record.
    const result = await runAgent(agent, runtime(), { prompt: "hello" }) as {
      stream: AsyncIterable<unknown>
      usageRecord?: { cost?: { usd: string } }
    }
    for await (const _chunk of result.stream) {}

    expect(result.usageRecord?.cost?.usd).toBe("0.02")
  })

  it("attaches deferred usage to returned UI message stream results", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    let resolveUsage!: (usage: { inputTokens: number, outputTokens: number, totalTokens: number }) => void
    const usage = new Promise<{ inputTokens: number, outputTokens: number, totalTokens: number }>((resolve) => {
      resolveUsage = resolve
    })
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-delta", delta: "ok" })
                resolveUsage({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
                controller.close()
              },
            })
          },
          usage,
        }),
      },
    })

    // SAFETY: This fixture's runAgent result exposes its UI stream and deferred usage record.
    const result = await runAgent(agent, runtime(), { prompt: "hello" }) as {
      toUIMessageStream: () => ReadableStream<unknown>
      usageRecord?: { cost?: { usd: string } }
    }
    for await (const _chunk of result.toUIMessageStream()) {}

    expect(result.usageRecord?.cost?.usd).toBe("0.02")
  })

  it("does not await unresolved UI usage when a streamAgent result is closed early", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "text-delta", delta: "ok" })
              },
            })
          },
          usage: new Promise(() => {}),
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    // SAFETY: The selected UI message output mode is consumed through its async iterable interface.
    const stream = await streamAgent(agent, runtime(), { prompt: "hello" }, { output: "ui-message-stream" }) as AsyncIterable<unknown>
    const consume = (async () => {
      for await (const _chunk of stream) break
    })()

    await expect(Promise.race([
      consume.then(() => "closed"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("closed")
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toBeUndefined()
  })

  it("does not await unresolved event usage when a streamAgent result is closed early", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" }
            await new Promise(() => {})
          })(),
          usage: new Promise(() => {}),
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    // SAFETY: streamAgent returns an async iterable for its default output mode.
    const stream = await streamAgent(agent, runtime(), { prompt: "hello" }) as AsyncIterable<unknown>
    const consume = (async () => {
      for await (const _chunk of stream) break
    })()

    await expect(Promise.race([
      consume.then(() => "closed"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])).resolves.toBe("closed")
    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toBeUndefined()
  })

  it("normalizes observed usage when a streamAgent result is closed early", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          stream: (async function* () {
            yield {
              type: "usage" as const,
              usageRecord: {
                usage: {
                  inputTokens: 10,
                  outputTokens: 2,
                  totalTokens: 12,
                },
              },
            }
            yield { type: "text-delta" as const, text: "unconsumed" }
          })(),
          usage: new Promise(() => {}),
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    // SAFETY: streamAgent returns an async iterable for its default output mode.
    const stream = await streamAgent(agent, {
      ...runtime(),
      run: { runId: "run-1" },
    }, { prompt: "hello" }) as AsyncIterable<unknown>
    for await (const chunk of stream) {
      // SAFETY: streamAgent output events expose an optional string discriminator.
      if ((chunk as { type?: string }).type === "usage") break
    }

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      run: { runId: "run-1" },
      usage: { totalTokens: 12 },
    })
  })

  it("returns runAgent UI message results before their usage promise settles", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    let resolveUsage!: (usage: { totalTokens: number }) => void
    const usage = new Promise<{ totalTokens: number }>((resolve) => {
      resolveUsage = resolve
    })
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "finish" })
                controller.close()
              },
            })
          },
          usage,
        }),
      },
    })

    const pending = runAgent(agent, runtime(), { prompt: "hello" })
    const outcome = await Promise.race([
      pending.then(() => "returned"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])
    resolveUsage({ totalTokens: 1 })

    expect(outcome).toBe("returned")
    // SAFETY: This fixture's pending runAgent value exposes its UI message stream method.
    const result = await pending as { toUIMessageStream: () => ReadableStream<unknown> }
    for await (const _chunk of result.toUIMessageStream()) {}
  })

  it("returns streamAgent UI message results before their usage promise settles", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    let resolveUsage!: (usage: { totalTokens: number }) => void
    const usage = new Promise<{ totalTokens: number }>((resolve) => {
      resolveUsage = resolve
    })
    const agent = defineAgent({
      capabilities: [cost({ pricing: () => undefined })],
      driver: {
        run: () => ({
          toUIMessageStream() {
            return new ReadableStream({
              start(controller) {
                controller.enqueue({ type: "finish" })
                controller.close()
              },
            })
          },
          usage,
        }),
      },
    })

    const pending = streamAgent(agent, runtime(), { prompt: "hello" }, { output: "ui-message-stream" })
    const outcome = await Promise.race([
      pending.then(() => "returned"),
      new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 50)),
    ])
    resolveUsage({ totalTokens: 1 })

    expect(outcome).toBe("returned")
    // SAFETY: This fixture's pending streamAgent value uses the selected readable-stream output mode.
    const stream = await pending as ReadableStream<unknown>
    for await (const _chunk of stream) {}
  })

  it("preserves resolved stream usage for finish hooks without eager extensions", async () => {
    const { defineAgent, streamAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      driver: {
        run: () => ({
          stream: (async function* () {
            yield { type: "text-delta", text: "ok" }
          })(),
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    const stream = await streamAgent(agent, runtime(), { prompt: "hello" })
    // SAFETY: streamAgent returns an async iterable for its default output mode.
    for await (const _chunk of stream as AsyncIterable<unknown>) {}

    expect(finish).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      usage: {
        totalTokens: 12,
      },
    })
  })

  it("prices usage records before yielding runAgent streams", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true,
      source: "custom" as const,
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => (async function* () {
          yield {
            type: "usage" as const,
            usageRecord: {
              usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
              },
            },
          }
        })(),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    const stream = await runAgent(agent, runtime(), { prompt: "hello" })
    const events = []
    // SAFETY: This fixture's runAgent result is the Driver's async iterable stream.
    for await (const event of stream as AsyncIterable<unknown>) events.push(event)

    expect(events).toEqual([{
      type: "usage",
      usageRecord: expect.objectContaining({
        cost: {
          display: "~$0.02",
          usd: "0.02",
          estimated: true,
          source: "custom",
        },
      }),
    }])
    expect(pricing).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toEqual(expect.objectContaining({
      cost: {
        display: "~$0.02",
        usd: "0.02",
        estimated: true,
        source: "custom",
      },
    }))
  })

  it("prices usage carried by raw finish chunks before yielding", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true,
      source: "custom" as const,
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => (async function* () {
          yield {
            totalUsage: {
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
            type: "finish" as const,
          }
        })(),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    const stream = await runAgent(agent, runtime(), { prompt: "hello" })
    const chunks = []
    // SAFETY: This fixture's runAgent result is the Driver's async iterable stream.
    for await (const chunk of stream as AsyncIterable<unknown>) chunks.push(chunk)

    expect(chunks).toEqual([{
      totalUsage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
      type: "finish",
      usageRecord: expect.objectContaining({
        cost: {
          display: "~$0.02",
          usd: "0.02",
          estimated: true,
          source: "custom",
        },
      }),
    }])
    expect(pricing).toHaveBeenCalledOnce()
    expect(finish.mock.calls[0]![0].invocation.usage).toEqual(expect.objectContaining({
      cost: {
        display: "~$0.02",
        usd: "0.02",
        estimated: true,
        source: "custom",
      },
    }))
  })

  it("preserves richer raw usage while attaching the canonical record", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const usage = {
      inputTokens: 10,
      outputTokens: 2,
      providerMetadata: {
        cacheTier: "ephemeral",
      },
      totalTokens: 12,
    }
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          text: "ok",
          usage,
        }),
      },
    })

    const result = await runAgent(agent, runtime(), { prompt: "hello" })
    // SAFETY: This fixture's Driver result retains the usage promise supplied above.
    expect((result as { usage?: unknown }).usage).toBe(usage)
    expect(result).toMatchObject({
      usageRecord: {
        cost: {
          usd: "0.02",
        },
      },
    })
  })

  it("returns the enriched resolved record when usage metadata is added", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usageRecord: {
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
          },
        }),
      },
    })

    await expect(runAgent(agent, {
      ...runtime(),
      run: { runId: "run-1" },
    }, { prompt: "hello" })).resolves.toMatchObject({
      usageRecord: {
        cost: {
          usd: "0.02",
          estimated: true,
          source: "custom",
        },
        model: "custom/model",
        run: {
          runId: "run-1",
        },
      },
    })
  })

  it("enriches immutable driver results without mutating them", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const result = Object.freeze({
      text: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    })
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => result,
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      usageRecord: {
        cost: {
          usd: "0.02",
        },
      },
    })
    expect(result).not.toHaveProperty("usageRecord")
  })

  it("enriches immutable usage records through a mutable canonical copy", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const usageRecord = Object.freeze({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    })
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord,
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      usageRecord: {
        cost: {
          usd: "0.02",
        },
      },
    })
    expect(usageRecord).not.toHaveProperty("cost")
  })

  it("wraps class-backed results without cloning their private state", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    class DriverResult {
      #value = "preserved"
      text = "ok"
      usage = {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      }

      value() {
        return this.#value
      }

    }
    const result = new DriverResult()
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => result,
      },
    })

    const enriched = await runAgent(agent, runtime(), { prompt: "hello" })
    expect(enriched).toBe(result)
    expect(enriched).toMatchObject({
      usageRecord: {
        cost: {
          usd: "0.02",
        },
      },
    })
    expect(result.value()).toBe("preserved")
  })

  it("preserves class-backed stream results while enriching their streams", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    class DriverStreamResult {
      #value = "preserved"
      stream = (async function* () {
        yield {
          type: "usage",
          usageRecord: {
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
          },
        }
      })()

      value() {
        return this.#value
      }

      get textStream() {
        const value = this.#value
        return (async function* () {
          yield value
        })()
      }
    }
    const result = new DriverStreamResult()
    const agent = defineAgent({
      capabilities: [cost({
        pricing: () => ({
          usd: "0.02",
          estimated: true,
          source: "custom",
        }),
      })],
      driver: {
        run: () => result,
      },
    })

    // SAFETY: This fixture's Driver returns the DriverStreamResult instance created above.
    const enriched = await runAgent(agent, runtime(), { prompt: "hello" }) as DriverStreamResult
    expect(enriched).toBe(result)
    expect(enriched.value()).toBe("preserved")
    const text = []
    for await (const chunk of enriched.textStream) text.push(chunk)
    expect(text).toEqual(["preserved"])
    const chunks = []
    for await (const chunk of enriched.stream) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({
      usageRecord: expect.objectContaining({
        cost: expect.objectContaining({
          usd: "0.02",
        }),
      }),
    }))
  })

  it("preserves Agent success when eager usage extraction fails", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => ({
          text: "ok",
          usage: Promise.reject(new Error("usage unavailable")),
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
    })
    expect(pricing).not.toHaveBeenCalled()
  })

  it("does not resolve unrelated lazy finish extensions during eager-only work", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const lazy = vi.fn(() => {
      throw new Error("lazy extension should not run")
    })
    const pricing = vi.fn(() => ({
      usd: "0.02",
      estimated: true,
      source: "custom" as const,
    }))
    const agent = defineAgent({
      capabilities: [
        {
          id: "lazy",
          finish: lazy,
        },
        cost({ pricing }),
      ],
      driver: {
        run: () => ({
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
    })
    expect(pricing).toHaveBeenCalledOnce()
    expect(lazy).not.toHaveBeenCalled()
  })

  it("does not estimate cost from total-only token usage", async () => {
    const fetch = vi.fn(async () => Response.json({
      data: [{
        id: "custom/model",
        pricing: {
          input: "0.000001",
          output: "0.000002",
        },
      }],
    }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const usageRecord = {
      usage: {
        totalTokens: 12,
      },
    }
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usageRecord,
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      usageRecord: {
        usage: {
          totalTokens: 12,
        },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("does not load pricing when usage has no model identity", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
      usageRecord: {
        usage: {
          totalTokens: 12,
        },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("retries catalog loading after a transient failure", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(Response.json({
        data: [{
          id: "custom/model",
          pricing: {
            input: "0.000001",
            output: "0.000002",
          },
        }],
      }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await runAgent(agent, runtime(), { prompt: "first" })
    await runAgent(agent, runtime(), { prompt: "second" })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toBeUndefined()
    expect(finish.mock.calls[1]![0].invocation.usage?.cost).toEqual({
      display: "~$0.000014",
      usd: "0.000014",
      estimated: true,
      source: "vercel-ai-gateway",
    })
  })

  it("refreshes cached catalog pricing after its freshness window", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        data: [{
          id: "custom/model",
          pricing: {
            input: "0.000001",
            output: "0.000002",
          },
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        data: [{
          id: "custom/model",
          pricing: {
            input: "0.000002",
            output: "0.000004",
          },
        }],
      }))
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    const first = await runAgent(agent, runtime(), { prompt: "first" })
    vi.advanceTimersByTime(5 * 60_000)
    const second = await runAgent(agent, runtime(), { prompt: "second" })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(first).toMatchObject({ usageRecord: { cost: { usd: "0.000014" } } })
    expect(second).toMatchObject({ usageRecord: { cost: { usd: "0.000028" } } })
  })

  it("shares one catalog refresh across concurrent invocations", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    let resolveRefresh!: (response: Response) => void
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve
    })
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        data: [{
          id: "custom/model",
          pricing: {
            input: "0.000001",
            output: "0.000002",
          },
        }],
      }))
      .mockReturnValueOnce(refresh)
    vi.stubGlobal("fetch", fetch)

    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [cost()],
      driver: {
        run: () => ({
          modelId: "custom/model",
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
    })

    await runAgent(agent, runtime(), { prompt: "prime" })
    vi.advanceTimersByTime(5 * 60_000)
    const first = runAgent(agent, runtime(), { prompt: "first" })
    const second = runAgent(agent, runtime(), { prompt: "second" })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    resolveRefresh(Response.json({
      data: [{
        id: "custom/model",
        pricing: {
          input: "0.000002",
          output: "0.000004",
        },
      }],
    }))

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    {
      name: "throws",
      pricing: () => {
        throw new Error("pricing unavailable")
      },
    },
    {
      name: "returns no cost",
      pricing: () => undefined,
    },
  ])("preserves usage and Agent success when pricing $name", async ({ pricing }) => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => ({
          text: "ok",
          usage: {
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
    })

    const event = finish.mock.calls[0]![0]
    expect(event.extensions.get("cost")).toBe(event.invocation.usage)
    expect(event.invocation.usage).toEqual(expect.objectContaining({
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    }))
    expect(event.invocation.usage?.cost).toBeUndefined()
  })

  it("keeps provider-reported cost without resolving another price", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn()
    const finish = vi.fn()
    const reportedCost = {
      usd: "0.01",
      estimated: false,
      source: "provider" as const,
    }
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord: {
            cost: reportedCost,
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
            },
          },
        }),
      },
      hooks: {
        "agent:finish": finish,
      },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })

    expect(pricing).not.toHaveBeenCalled()
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toEqual({
      ...reportedCost,
      display: "$0.01",
    })
  })

  it("prices compound calls independently before aggregating their cost", async () => {
    const { cost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(async ({ model }: { model?: string }) => ({
      estimated: true,
      source: "test",
      usd: model === "original" ? "0.4" : "0.2",
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [cost({ pricing })],
      driver: { run: () => ({
          text: "ok",
          usageRecord: {
            calls: [
              { model: "original", usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } },
              { model: "repair", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } },
            ],
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          },
        }) },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })

    expect(pricing).toHaveBeenCalledTimes(2)
    expect(finish.mock.calls[0]![0].invocation.usage).toMatchObject({
      calls: [
        { cost: { usd: "0.4" }, model: "original" },
        { cost: { usd: "0.2" }, model: "repair" },
      ],
      cost: { display: "~$0.6", estimated: true, source: "test", usd: "0.6" },
    })
  })
})
