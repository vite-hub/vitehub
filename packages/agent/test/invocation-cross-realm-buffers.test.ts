import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"

describe("Agent invocation buffer boundaries", () => {
  async function createInvocation() {
    const store = createMemoryAgentInvocationStore()
    const timestamp = "2026-01-01T00:00:00.000Z"
    await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    return { store, timestamp, invocations: defineAgentInvocations({ content: "content", store }) }
  }

  it("preserves an ArrayBuffer created in another realm in observation attributes", async () => {
    const { store, timestamp, invocations } = await createInvocation()
    const bytes = runInNewContext("new Uint8Array([1, 2, 255]).buffer")
    await invocations.appendObservation("fixture", {
      name: "report", type: "capability", timestamp,
      attributes: { bytes },
    }, { id: "report" })
    const saved = await store.get("fixture")
    expect(saved?.observations[0]?.attributes?.bytes).toEqual([1, 2, 255])
  })

  it("does not read shadowed byteLength properties", async () => {
    const { store, timestamp, invocations } = await createInvocation()
    const bytes = runInNewContext("Object.defineProperty(new Uint8Array([4, 5]).buffer, 'byteLength', { value: () => { throw new Error('shadowed') } })")
    await invocations.appendObservation("fixture", { name: "report", type: "capability", timestamp, attributes: { bytes } }, { id: "report" })
    expect((await store.get("fixture"))?.observations[0]?.attributes?.bytes).toEqual([4, 5])
  })

  it("keeps detached and revoked buffers from aborting observation persistence", async () => {
    const { store, timestamp, invocations } = await createInvocation()
    const detached = new ArrayBuffer(4)
    structuredClone(detached, { transfer: [detached] })
    const revoked = Proxy.revocable(new ArrayBuffer(2), {})
    revoked.revoke()
    await invocations.appendObservation("fixture", {
      name: "report", type: "capability", timestamp, attributes: { detached, revoked: revoked.proxy },
    }, { id: "report" })
    expect((await store.get("fixture"))?.observations).toHaveLength(1)
  })
})
