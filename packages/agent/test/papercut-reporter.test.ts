import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { expect, it, vi } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import { createPapercutReporter, type PapercutDelivery } from "../src/papercut-reporter.ts"

const timestamp = "2026-09-05T00:00:00.000Z"
const delivery: PapercutDelivery = { uuid: "6e39db8d-85f0-5bfd-91c1-2112daa46d49", timestamp, properties: { invocation_id: "run", papercut_id: "cut", message: "Search failed." } }
async function fixture() {
  const store = createMemoryAgentInvocationStore()
  await store.create({ id: "run", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
  return defineAgentInvocations({ content: "content", store })
}

it("persists before sending, coalesces concurrent deliveries, and records an acknowledgement", async () => {
  const journal = await fixture()
  const send = vi.fn(async () => {
    expect((await journal.get("run"))?.observations.some(item => item.name === "agent.papercut.pending")).toBe(true)
  })
  const reporter = createPapercutReporter({ invocations: () => journal, send })
  await Promise.all(Array.from({ length: 5 }, () => reporter.report(delivery)))
  await reporter.report(delivery)
  expect(send).toHaveBeenCalledOnce()
  expect((await journal.get("run"))?.observations.map(item => item.name)).toEqual(["agent.papercut.pending", "agent.papercut.delivered"])
  await reporter.stop()
  await expect(reporter.report(delivery)).rejects.toThrow("closed")
})

it("never exports an unpersisted report or acknowledges a failed delivery", async () => {
  const journal = await fixture()
  const send = vi.fn(async () => { throw new Error("offline") })
  const reporter = createPapercutReporter({ invocations: () => journal, send })
  await expect(reporter.report({ ...delivery, properties: { ...delivery.properties, invocation_id: "missing" } })).rejects.toThrow("persisted")
  expect(send).not.toHaveBeenCalled()
  await expect(reporter.report(delivery)).rejects.toThrow("offline")
  expect((await journal.get("run"))?.observations).toHaveLength(1)
  await reporter.stop()
})

it("replays a failed report after reopening SQLite with its original ID and timestamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-papercuts-"))
  const url = `file:${join(directory, "journal.sqlite")}`
  const first = createClient({ url })
  const second = createClient({ url })
  const store = createLibsqlAgentInvocationStore({ client: first, maxAgeMs: false, maxRecords: false })
  try {
    await store.create({ id: "run", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "trace" })
    const reporter = createPapercutReporter({ eventPrefix: "quiver.papercut", invocations: () => defineAgentInvocations({ content: "content", store }), send: async () => { throw new Error("offline") } })
    await expect(reporter.report(delivery)).rejects.toThrow("offline")
    await reporter.stop()
    first.close()
    const restarted = defineAgentInvocations({ content: "content", store: createLibsqlAgentInvocationStore({ client: second, maxAgeMs: false, maxRecords: false }) })
    const send = vi.fn(async () => {})
    const replay = createPapercutReporter({ eventPrefix: "quiver.papercut", invocations: () => restarted, send, intervalMs: 10 })
    replay.start()
    try {
      await vi.waitFor(async () => expect((await restarted.get("run"))?.observations).toHaveLength(2))
      expect(send).toHaveBeenCalledExactlyOnceWith(delivery, expect.any(AbortSignal))
    }
    finally { await replay.stop() }
  }
  finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }) }
})

it("continues replay after one delivery fails", async () => {
  const journal = await fixture()
  const later = { ...delivery, uuid: "a9f70f76-04e0-5df7-a930-39404c45969c", properties: { ...delivery.properties, papercut_id: "later" } }
  const persist = createPapercutReporter({ invocations: () => journal, send: async () => { throw new Error("offline") } })
  await expect(persist.report(delivery)).rejects.toThrow("offline")
  await expect(persist.report(later)).rejects.toThrow("offline")
  await persist.stop()

  const onError = vi.fn()
  const send = vi.fn(async (item: PapercutDelivery) => {
    if (item.uuid === delivery.uuid) throw new Error("still offline")
  })
  const replay = createPapercutReporter({ invocations: () => journal, send, onError, intervalMs: 1000 })
  replay.start()
  try {
    await vi.waitFor(async () => expect((await journal.get("run"))?.observations.some(item => item.name === "agent.papercut.delivered" && item.attributes?.["papercut.uuid"] === later.uuid)).toBe(true))
    expect(send).toHaveBeenCalledWith(delivery, expect.any(AbortSignal))
    expect(send).toHaveBeenCalledWith(later, expect.any(AbortSignal))
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "still offline" }))
  }
  finally { await replay.stop() }
})

it("bounds a stuck delivery and leaves it pending for replay", async () => {
  const journal = await fixture()
  let signal: AbortSignal | undefined
  const reporter = createPapercutReporter({ invocations: () => journal, deliveryTimeoutMs: 10, send: async (_delivery, abort) => { signal = abort; return new Promise(() => {}) } })
  await expect(reporter.report(delivery)).rejects.toThrow("timed out")
  expect(signal?.aborted).toBe(true)
  await reporter.stop()
  expect((await journal.get("run"))?.observations).toHaveLength(1)
})
