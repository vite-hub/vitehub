import { describe, expect, it } from "vitest"
import { createAgentInvocationContextStore } from "../src/invocation-context.ts"
import { invocationUsageWithAuxiliaryCalls, recordAuxiliaryUsage } from "../src/internal/auxiliary-usage.ts"

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

  it("does not present auxiliary usage as a complete total when primary usage is missing", () => {
    const context = createAgentInvocationContextStore()
    const title = { usage: { totalTokens: 5 } }
    recordAuxiliaryUsage(context, title)
    expect(invocationUsageWithAuxiliaryCalls(context, undefined)).toEqual({ calls: [{}, title], usage: {} })
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
