import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

describe("Agent invocation buffer boundaries", () => {
  it("preserves an ArrayBuffer created in another realm in observation attributes", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const invocations = defineAgentInvocations({ content: "content", store })
    const bytes = runInNewContext("new Uint8Array([1, 2, 255]).buffer")
    await invocations.appendObservation("fixture", {
      name: "report", type: "capability", timestamp,
      attributes: { bytes },
    }, { id: "report" })
    const saved = await store.get("fixture")
    expect(saved?.observations[0]?.attributes?.bytes).toEqual([1, 2, 255])
  })

  it("preserves a SharedArrayBuffer created in another realm in observation attributes", async () => {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({ id: "shared-buffer", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const invocations = defineAgentInvocations({ content: "content", store })
    const bytes = runInNewContext("(() => { const buffer = new SharedArrayBuffer(3); new Uint8Array(buffer).set([1, 2, 3]); return buffer })()")
    await invocations.appendObservation("shared-buffer", {
      name: "report", type: "capability", timestamp,
      attributes: { bytes },
    }, { id: "report" })
    const saved = await store.get("shared-buffer")
    expect(saved?.observations[0]?.attributes?.bytes).toEqual([1, 2, 3])
  })
})
