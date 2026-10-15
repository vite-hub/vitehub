import { describe, expect, expectTypeOf, it, vi } from "vitest"

const runtime = () => ({
  memo: vi.fn(),
  runtime: "unknown" as const,
  runtimeConfig: {},
  waitUntil: vi.fn(),
})

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined

describe("budget Capability", () => {
  it("installs the same policy from the top-level Agent setting", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const agent = defineAgent({ budget: { tokens: 10, pricing: false }, driver: { run: () => "ok" } })
    expect(agent.capabilities?.map(capability => capability.id)).toContain("budget")
  })

  it("accepts a capacity-only top-level policy", async () => {
    const { defineAgent } = await import("../src/index.ts")
    const agent = defineAgent({ budget: { capacity: { concurrency: 2 } }, driver: { run: () => "ok" } })
    expect(agent.capabilities?.map(capability => capability.id)).toContain("budget")
  })

  it("applies capacity-only budgets to Driver admission", async () => {
    const { createAgentInspectionMetadata, defineAgent, runAgentInline } = await import("../src/index.ts")
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const run = vi.fn(async () => { await gate; return "ok" })
    const agent = defineAgent({
      budget: { capacity: { concurrency: 1, queue: { maxPending: 1 } } },
      driver: { run },
      runtime: false,
    })
    const first = runAgentInline(agent, runtime(), { prompt: "first" })
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    const second = runAgentInline(agent, runtime(), { prompt: "second" })
    try {
      await vi.waitFor(() => expect(createAgentInspectionMetadata(agent)).toMatchObject({
        config: { driver: { capacity: { active: 1, pending: 1 } } },
      }))
      expect(run).toHaveBeenCalledTimes(1)
    }
    finally {
      release()
      await expect(Promise.all([first, second])).resolves.toEqual(["ok", "ok"])
    }
    expect(run).toHaveBeenCalledTimes(2)
  })

  it("rejects an empty top-level budget", async () => {
    const { defineAgent } = await import("../src/index.ts")
    expect(() => defineAgent({ budget: { mode: "enforce" }, driver: { run: () => "ok" } })).toThrow("requires tokens, usd, or capacity")
  })

  it("rejects a malformed falsy top-level capacity", async () => {
    const { defineAgent } = await import("../src/index.ts")
    expect(() => defineAgent({ budget: { capacity: null } as never, driver: { run: () => "ok" } })).toThrow("driver.capacity")
  })

  it("emits fallback usage and every finish before a UI source closes or fails", async () => {
    const { budget } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    let sourceController: ReadableStreamDefaultController<unknown> | undefined
    const agent = defineAgent({ capabilities: [budget({ tokens: 10, pricing: false })], driver: { run: () => ({ usageRecord: { usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }, fullStream: (async function* () { yield { type: "finish" } })(), toUIMessageStream: () => new ReadableStream<unknown>({ start(controller) { sourceController = controller; controller.enqueue({ type: "finish", reason: "first" }); controller.enqueue({ type: "finish", reason: "second" }) } }) }) } })
    const result = await runAgent(agent, runtime(), { prompt: "hello" }) as { toUIMessageStream: () => ReadableStream<unknown> }
    const reader = result.toUIMessageStream().getReader()
    try {
      expect((await reader.read()).value).toMatchObject({ type: "usage", usageRecord: { usage: { totalTokens: 12 } } })
      expect((await reader.read()).value).toEqual({ type: "finish", reason: "first" })
      expect((await reader.read()).value).toEqual({ type: "finish", reason: "second" })
      sourceController!.error(new Error("source failed after finish"))
      await expect(reader.read()).rejects.toThrow("source failed after finish")
    } finally { await reader.cancel().catch(() => {}) }
  }, 15_000)

  it("accepts provider usage records backed by getters on a prototype", async () => {
    const { budget } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    class ProviderUsageRecord {
      get usage() {
        return { inputTokens: 8, outputTokens: 4, totalTokens: 12 }
      }

      get cost() {
        return { display: "$0.02", estimated: false, source: "provider", usd: "0.02" }
      }
    }
    const agent = defineAgent({
      capabilities: [budget({ tokens: 10, usd: "0.01", pricing: false })],
      driver: {
        run: () => ({ text: "ok", usageRecord: new ProviderUsageRecord() }),
      },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })
    expect(finish.mock.calls[0]![0].extensions.get("budget")).toMatchObject({
      exceeded: [
        { metric: "totalTokens", actual: 12, limit: 10 },
        { metric: "usd", actual: "0.02", limit: "0.01" },
      ],
    })
  }, 15_000)

  it("normalizes frozen records from a custom accessor prototype", async () => {
    const { budget } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const prototype = {
      get usage() {
        return { inputTokens: 6, outputTokens: 6, totalTokens: 12 }
      },
      get cost() {
        return { display: "$0.03", estimated: false, source: "provider", usd: "0.03" }
      },
    }
    const usageRecord = Object.freeze(Object.create(prototype))
    const agent = defineAgent({
      capabilities: [budget({ tokens: { total: 11 }, usd: "0.02", pricing: false })],
      driver: {
        run: () => ({ text: "ok", usageRecord }),
      },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })
    expect(finish.mock.calls[0]![0].extensions.get("budget")).toMatchObject({
      exceeded: [
        { metric: "totalTokens", actual: 12, limit: 11 },
        { metric: "usd", actual: "0.03", limit: "0.02" },
      ],
    })
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

    const error = await runAgent(agent, runtime(), { prompt: "hello" }).catch(error => error)
    expect(error).toMatchObject({ code: "AGENT_BUDGET_EXCEEDED", details: { limits: { tokens: { total: 10 } } } })
    const limits = record(record(error)?.details)?.limits
    const tokens = record(limits)?.tokens
    expect(Object.hasOwn(record(tokens) || {}, "input")).toBe(false)
    expect(Object.hasOwn(record(tokens) || {}, "output")).toBe(false)
  })

  it("accepts numeric USD limits that use scientific notation", async () => {
    const { budget } = await import("../src/capabilities.ts")
    const { defineAgent, runAgent } = await import("../src/index.ts")
    const finish = vi.fn()
    const agent = defineAgent({
      capabilities: [budget({ usd: 1e-7, pricing: false })],
      driver: {
        run: () => ({
          text: "ok",
          usageRecord: {
            cost: { display: "$0.00000011", estimated: false, source: "provider", usd: "0.00000011" },
            usage: {},
          },
        }),
      },
      hooks: { "agent:finish": finish },
    })

    await runAgent(agent, runtime(), { prompt: "hello" })
    expect(finish.mock.calls[0]![0].extensions.get("budget")).toMatchObject({
      exceeded: [{ metric: "usd", actual: "0.00000011", limit: 1e-7 }],
    })
  })

  it("rejects an empty budget", async () => {
    const { budget } = await import("../src/capabilities.ts")
    expect(() => budget({ pricing: false })).toThrow("requires tokens, usd, or capacity")
  })

  it("does not let extra public arguments bypass standalone capacity rejection", async () => {
    const { budget } = await import("../src/capabilities.ts")
    expectTypeOf(budget).parameters.toEqualTypeOf<[options: import("../src/types.ts").AgentBudgetOptions]>()
    expect(() => Reflect.apply(budget, undefined, [
      { capacity: { concurrency: 1 }, pricing: false },
      { allowCapacity: true },
    ])).toThrow("capacity is only supported through defineAgent")
    expect(() => Reflect.apply(budget, undefined, [
      { tokens: 10, capacity: { typo: true }, pricing: false },
      { allowCapacity: true },
    ])).toThrow("capacity is only supported through defineAgent")
  })

  it("rejects capacity on standalone budget capabilities", async () => {
    const { budget } = await import("../src/capabilities.ts")
    expect(() => budget({ capacity: { concurrency: 1 }, pricing: false })).toThrow("capacity is only supported through defineAgent")
  })
})
