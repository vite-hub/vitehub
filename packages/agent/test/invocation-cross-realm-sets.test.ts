import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

describe("Agent invocation Set boundaries", () => {
  it("preserves a Set created in another realm in observation attributes", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const invocations = defineAgentInvocations({ content: "content", store })
    const values = runInNewContext("new Set(['alpha', 'beta'])")
    await invocations.appendObservation("fixture", {
      name: "report", type: "capability", timestamp,
      attributes: { values },
    }, { id: "report" })
    const saved = await store.get("fixture")
    expect(saved?.observations[0]?.attributes?.values).toEqual(["alpha", "beta"])
  })
})
