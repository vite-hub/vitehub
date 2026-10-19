import { describe, expect, it } from "vitest"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { enrichAgentUsageCost } from "../src/internal/usage-pricing.ts"
import { invocationUsageWithAuxiliaryCalls, recordAuxiliaryUsage, recordDriverUsage } from "../src/internal/auxiliary-usage.ts"

describe("auxiliary invocation usage", () => {
  it("retains per-call model and cost evidence while totaling known tokens", () => {
    const context = createAgentInvocationContextStore()
    const primary = { model: "answer", usage: { inputTokens: 10, totalTokens: 17 } }
    const title = { model: "title", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }, cost: { display: "$0.01", usd: "0.01", estimated: false, source: "provider" as const } }
    recordAuxiliaryUsage(context, title)
    expect(invocationUsageWithAuxiliaryCalls(context, primary)).toEqual({
      calls: [primary, title],
      usage: { inputTokens: 13, totalTokens: 22 },
    })
    expect(primary.usage).toEqual({ inputTokens: 10, totalTokens: 17 })
  })

  it.each([false, true])("preserves primary cost when auxiliary pricing is available: %s", async (priced) => {
    const context = createAgentInvocationContextStore()
    const primary = { usage: { totalTokens: 17 }, cost: { display: "$0.02", usd: "0.02", estimated: false, source: "provider" as const } }
    const title = { usage: { totalTokens: 5 } }
    recordAuxiliaryUsage(context, title)
    const aggregate = invocationUsageWithAuxiliaryCalls(context, primary)!
    expect(aggregate.cost).toEqual(primary.cost)
    const enriched = await enrichAgentUsageCost(aggregate, () => priced ? { usd: "0.01", estimated: false, source: "provider" } : undefined)
    expect(enriched.cost?.usd).toBe(priced ? "0.03" : "0.02")
    expect(enriched.calls?.[1]?.cost?.usd).toBe(priced ? "0.01" : undefined)
    expect(primary.cost.usd).toBe("0.02")
  })

  it("preserves authoritative compound costs inside an auxiliary aggregate", async () => {
    const context = createAgentInvocationContextStore()
    const cost = { display: "$0.02", usd: "0.02", estimated: false, source: "provider" as const }
    const primary = { cost, calls: [{ cost: { ...cost, usd: "0.01" } }] }
    const enrichedPrimary = await enrichAgentUsageCost(primary, () => undefined)
    expect(enrichedPrimary.cost).toEqual(cost)
    expect(enrichedPrimary.calls?.[0]?.cost?.usd).toBe("0.01")

    recordAuxiliaryUsage(context, { usage: { totalTokens: 5 } })
    const aggregate = invocationUsageWithAuxiliaryCalls(context, primary)!
    const partial = await enrichAgentUsageCost(aggregate, () => undefined)
    expect(partial.cost).toEqual(cost)
    const complete = await enrichAgentUsageCost(partial, () => ({ ...cost, usd: "0.03" }))
    expect(complete.cost?.usd).toBe("0.05")
    expect(complete.calls?.[0]?.cost).toEqual(cost)
    expect(primary.cost).toEqual(cost)
  })

  it("does not present auxiliary usage as a complete total when primary usage is missing", () => {
    const context = createAgentInvocationContextStore()
    const title = { usage: { totalTokens: 5 } }
    recordAuxiliaryUsage(context, title)
    expect(invocationUsageWithAuxiliaryCalls(context, undefined)).toEqual({ calls: [{}, title], usage: {} })
  })

  it("totals the calls of a Driver that reports each call, without an unknown primary call", () => {
    const context = createAgentInvocationContextStore()
    const first = { model: "jev", provider: "typesafe", usage: { inputTokens: 400, outputTokens: 4, totalTokens: 404 } }
    const second = { model: "jev", provider: "typesafe", usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 } }
    recordDriverUsage(context, first)
    recordDriverUsage(context, second)
    expect(invocationUsageWithAuxiliaryCalls(context, undefined)).toEqual({
      calls: [first, second],
      model: "jev",
      usage: { inputTokens: 500, outputTokens: 5, totalTokens: 505 },
    })

    const titled = createAgentInvocationContextStore()
    const title = { model: "title", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
    recordDriverUsage(titled, first)
    recordAuxiliaryUsage(titled, title)
    expect(invocationUsageWithAuxiliaryCalls(titled, undefined)).toEqual({
      calls: [first, title],
      usage: { inputTokens: 403, outputTokens: 6, totalTokens: 409 },
    })
  })

  it("prices each Driver call when the pricing knows every call", async () => {
    const context = createAgentInvocationContextStore()
    recordDriverUsage(context, { model: "jev", usage: { inputTokens: 400, outputTokens: 4, totalTokens: 404 } })
    recordDriverUsage(context, { model: "jev", usage: { inputTokens: 100, outputTokens: 1, totalTokens: 101 } })
    const priced = await enrichAgentUsageCost(invocationUsageWithAuxiliaryCalls(context, undefined)!, ({ usage }) => ({
      estimated: false,
      source: "test",
      usd: ((usage.inputTokens ?? 0) / 1e6).toFixed(6),
    }))
    expect(priced.calls?.map(call => call.cost?.usd)).toEqual(["0.000400", "0.000100"])
    expect(priced.cost?.usd).toBe("0.0005")
  })

  it("keeps invocation usage isolated and leaves primary-only records intact", () => {
    const first = createAgentInvocationContextStore()
    const second = createAgentInvocationContextStore()
    const primary = { usage: { totalTokens: 17 } }
    recordAuxiliaryUsage(first, { usage: { totalTokens: 5 } })
    recordAuxiliaryUsage(second, undefined)
    expect(invocationUsageWithAuxiliaryCalls(second, primary)).toBe(primary)
    expect(invocationUsageWithAuxiliaryCalls(first, primary)?.usage?.totalTokens).toBe(22)
    expect(invocationUsageWithAuxiliaryCalls(first, primary)?.usage?.totalTokens).toBe(22)
  })
})
