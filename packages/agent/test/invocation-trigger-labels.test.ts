import { describe, expect, it } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

describe("invocation trigger labels", () => {
  it("lists annotation labels and filters memory records by their normalized label", async () => {
    const store = createMemoryAgentInvocationStore()
    for (const [id, agentName, label] of [
      ["one", "alpha", " Alice "],
      ["two", "alpha", "Alice"],
      ["three", "beta", "Bob"],
      ["four", "alpha", true],
    ] as const) {
      await store.create({ id, agentName, annotations: { triggeredBy: label }, observations: [], status: "completed", createdAt: "2026-09-13", updatedAt: "2026-09-13", traceId: id })
    }
    const invocations = defineAgentInvocations({ store })
    expect(await invocations.listTriggeredBy()).toEqual(["Alice", "Bob"])
    expect(await invocations.listTriggeredBy(" alpha ")).toEqual(["Alice"])
    expect((await invocations.list({ triggeredBy: " Alice " })).invocations.map(item => item.id).sort()).toEqual(["one", "two"])
    expect((await invocations.list({ triggeredBy: "true" })).invocations).toEqual([])
  })
})
