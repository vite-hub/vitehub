import { expect, it, vi } from "vitest"
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

it("opens the store before startup recovery and reuses it for journal operations", async () => {
  const store = createMemoryAgentInvocationStore()
  await store.create({ id: "interrupted", traceId: "interrupted", status: "running", observations: [], createdAt: "2020-01-01T00:00:00Z", updatedAt: "2020-01-01T00:00:00Z" })
  const list = store.list.bind(store)
  let ready = false
  store.open = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 100))
    ready = true
  })
  store.list = options => {
    if (!ready) throw new Error("Store is not open")
    return list(options)
  }

  const invocations = await createProcessAgentInvocations({ store, storeTimeoutMs: 20, recovery: { recover: () => true } })

  await expect(invocations.get("interrupted")).resolves.toMatchObject({ status: "failed" })
  await expect(invocations.list()).resolves.toMatchObject({ invocations: [{ id: "interrupted", status: "failed" }] })
  expect(store.open).toHaveBeenCalledOnce()
})
