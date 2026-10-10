import { describe, expect, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

describe("budget Capability", () => {
  it("installs the same policy from the top-level Agent setting", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      budget: { tokens: 10, pricing: false },
      driver: { run: () => "ok" },
    })

    expect(agent.capabilities?.map(capability => capability.id)).toContain("budget")
  })

  it("reports token and provider cost exceedance", async () => {
    const { budget } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [budget({ tokens: { total: 100, output: 19 }, usd: "0.01", pricing: false })],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord: {
            cost: { display: "$0.012", estimated: false, source: "provider", usd: "0.012" },
            usage: { inputTokens: 90, outputTokens: 20, totalTokens: 110 },
          },
        }),
      },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })
    expect(finish.mock.calls[0]![0].extensions.get("budget")).toMatchObject({
      exceeded: [
        { metric: "outputTokens", actual: 20, limit: 19 },
        { metric: "totalTokens", actual: 110, limit: 100 },
        { metric: "usd", actual: "0.012", limit: "0.01" },
      ],
    })
  })

  it("can reject an invocation after usage is known", async () => {
    const { budget } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const agent = defineAgent({
      capabilities: [budget({ tokens: 10, mode: "enforce", pricing: false })],
      driver: {
        run: () => ({ text: "too much", usage: { inputTokens: 11, outputTokens: 1, totalTokens: 12 } }),
      },
    })

    await expect(runAgent(agent, runtime(), { prompt: "hello" })).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" })
  })

  it("rejects an empty budget", async () => {
    const { budget } = await import("../src/capabilities.ts")
    expect(() => budget({ pricing: false })).toThrow("requires tokens or usd")
  })
})
