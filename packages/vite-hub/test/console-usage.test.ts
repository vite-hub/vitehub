import { describe, expect, it } from "vitest"

import { invocationUsage } from "../src/console/runtime/server/usage.ts"

function invocationRecord(usage: Record<string, unknown>) {
  return {
    createdAt: "2026-08-27T10:00:00.000Z",
    id: "usage-invocation",
    observations: [{
      attributes: { "usage.record": { usage } },
      name: "agent.invocation.finish",
      sequence: 1,
      timestamp: "2026-08-27T10:00:00.000Z",
      type: "lifecycle" as const,
    }],
    status: "completed" as const,
    traceId: "usage-trace",
    updatedAt: "2026-08-27T10:00:00.000Z",
  } satisfies Parameters<typeof invocationUsage>[0]
}

describe("Console usage projection", () => {
  it("reads reasoning tokens from fallback usage details", () => {
    expect(invocationUsage(invocationRecord({
      details: { reasoningOutputTokens: 4 },
      totalTokens: 10,
    }))).toEqual({ reasoningTokens: 4, totalTokens: 10 })
  })

  it("prefers normalized output token details", () => {
    expect(invocationUsage(invocationRecord({
      details: { reasoningOutputTokens: 9 },
      outputTokenDetails: { reasoningTokens: 0 },
      totalTokens: 10,
    }))).toEqual({ reasoningTokens: 0, totalTokens: 10 })
  })
})
