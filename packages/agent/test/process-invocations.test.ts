import { expect, it } from "vitest"
import { createMemoryAgentInvocationStore } from "../src/server.ts"
import { createProcessAgentInvocations } from "../src/runtime/process.ts"

it("recovers only invocations owned by this host before returning the journal", async () => {
  const store = createMemoryAgentInvocationStore()
  for (const id of ["owned", "other"]) {
    await store.create({ id, traceId: id, status: "running", observations: [], createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" })
  }
  const invocations = await createProcessAgentInvocations({ store, recovery: { recover: invocation => invocation.id === "owned" } })
  expect((await invocations.get("owned"))?.status).toBe("failed")
  expect((await invocations.get("other"))?.status).toBe("running")
})

it("does not admit work when recovery storage is unavailable", async () => {
  const store = createMemoryAgentInvocationStore()
  store.list = async () => { throw new Error("storage unavailable") }
  await expect(createProcessAgentInvocations({ store, recovery: { recover: () => true } })).rejects.toThrow("storage unavailable")
})
