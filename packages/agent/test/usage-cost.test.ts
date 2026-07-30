import { afterEach, describe, expect, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("usageCost", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("enriches canonical usage with cache-aware Vercel AI Gateway cost", async () => {
    const fetch = vi.fn(async () => Response.json({
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

    const { usageCost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [usageCost()],
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
    expect(event.extensions.get("usage-cost")).toBe(event.invocation.usage)
    expect(event.invocation.usage?.cost).toEqual({
      amount: "0.00125",
      currency: "USD",
      estimated: true,
      source: "vercel-ai-gateway",
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("supports custom pricing without provider dependencies", async () => {
    const { usageCost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      amount: "0.42",
      currency: "USD" as const,
      estimated: false,
      source: "custom" as const,
    }))
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [usageCost({ pricing })],
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
      model: expect.objectContaining({ id: "custom/model" }),
      usage: expect.objectContaining({ totalTokens: 12 }),
    }))
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toEqual({
      amount: "0.42",
      currency: "USD",
      estimated: false,
      source: "custom",
    })
  })

  it("enriches canonical usage without requiring a finish hook", async () => {
    const { usageCost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn(() => ({
      amount: "0.02",
      currency: "USD" as const,
      estimated: true,
      source: "custom" as const,
    }))
    const usageRecord = {
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
      },
    }
    const agent = defineAgent({
      capabilities: [usageCost({ pricing })],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord,
        }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).resolves.toMatchObject({
      text: "ok",
    })
    expect(pricing).toHaveBeenCalledOnce()
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

    const { usageCost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const usageRecord = {
      usage: {
        totalTokens: 12,
      },
    }
    const agent = defineAgent({
      capabilities: [usageCost()],
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
    const { usageCost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [usageCost({ pricing })],
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
    expect(event.extensions.get("usage-cost")).toBe(event.invocation.usage)
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
    const { usageCost } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const pricing = vi.fn()
    const finish = vi.fn()
    const cost = {
      amount: "0.01",
      currency: "USD" as const,
      estimated: false,
      source: "provider" as const,
    }
    const agent = defineAgent({
      capabilities: [usageCost({ pricing })],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord: {
            cost,
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
    expect(finish.mock.calls[0]![0].invocation.usage?.cost).toBe(cost)
  })
})
