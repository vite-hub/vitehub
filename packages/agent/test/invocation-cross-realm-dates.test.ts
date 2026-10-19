import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

describe("Agent invocation date boundaries", () => {
  it("preserves a foreign Date in bounded observation attributes", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const invocations = defineAgentInvocations({ content: "content", store })
    const date = runInNewContext("new Date('2026-01-02T03:04:05.000Z')")
    await invocations.appendObservation("fixture", {
      name: "report", type: "capability", timestamp,
      attributes: { observedAt: date },
    }, { id: "report" })
    const saved = await store.get("fixture")
    expect(saved?.observations[0]?.attributes?.observedAt).toEqual({ type: "Date", value: "2026-01-02T03:04:05.000Z" })
  })

  it("ignores overridden Date methods while serializing a foreign Date", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const invocations = defineAgentInvocations({ content: "content", store })
    const date = runInNewContext("Object.assign(new Date('2026-01-02T03:04:05.000Z'), { getTime() { throw new Error('overridden') }, toISOString() { throw new Error('overridden') } })")
    await invocations.appendObservation("fixture", {
      name: "report", type: "capability", timestamp,
      attributes: { observedAt: date },
    }, { id: "report" })
    const saved = await store.get("fixture")
    expect(saved?.observations[0]?.attributes?.observedAt).toEqual({ type: "Date", value: "2026-01-02T03:04:05.000Z" })
  })
})
