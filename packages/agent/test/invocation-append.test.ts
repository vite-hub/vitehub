import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { expect, it } from "vitest"
import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

it.each(["memory", "sqlite"] as const)("appends concurrent live and terminal evidence idempotently in %s", async (adapter) => {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-observation-append-"))
  const url = `file:${join(directory, "archive.sqlite")}`
  const clients = Array.from({ length: 2 }, () => createClient({ url }))
  const options = { maxAgeMs: false, maxRecords: false } as const
  const stores = adapter === "sqlite"
    ? [createLibsqlAgentInvocationStore({ ...options, client: clients[0] })]
    : [createMemoryAgentInvocationStore()]
  const timestamp = "2026-01-01T00:00:00.000Z"
  try {
    const store = stores[0]!
    for (const candidate of stores) await candidate.list()
    await store.create({ id: "fixture", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "fixture-trace" })
    await store.claim("fixture", "owner", 60000)
    const claim = await store.getClaimToken("fixture")
    const invocations = stores.map(store => defineAgentInvocations({ content: "content", store }))
    const pending = { name: "report.pending", type: "capability" as const, timestamp, attributes: { "report.uuid": "fixture-report" } }
    await Promise.all(Array.from({ length: 8 }, (_, index) => invocations[index % invocations.length]!.appendObservation("fixture", pending, { id: "pending:fixture-report" })))
    expect((await store.get("fixture"))?.observations).toHaveLength(1)
    // The live journal can have allocated the same sequence before the external append.
    await store.update("fixture", { observation: { name: "journal.event", type: "run", timestamp, sequence: 1 }, timestamp }, "owner")
    await store.update("fixture", { status: "failed", timestamp }, "owner")
    await Promise.all(Array.from({ length: 8 }, (_, index) => invocations[index % invocations.length]!.appendObservation("fixture", { ...pending, name: "report.delivered" }, { id: `ack:${index}` })))
    const saved = await store.get("fixture")
    expect(saved?.observations).toHaveLength(10)
    expect(saved?.observations[0]?.attributes?.["vitehub.observation.appended"]).toBe(true)
    expect(new Set(saved?.observations.map(event => event.sequence)).size).toBe(10)
    expect(saved?.status).toBe("failed")
    expect(saved?.failedAt).toBe(timestamp)
    expect(await store.getClaimToken("fixture")).toBe(claim)
    expect(await invocations[0]!.appendObservation("missing", pending, { id: "pending:missing" })).toBeUndefined()
    if (adapter === "sqlite") {
      const restarted = createLibsqlAgentInvocationStore({ ...options, client: clients[1] })
      expect((await restarted.get("fixture"))?.observations).toEqual(saved?.observations)
    }
  }
  finally {
    clients.forEach(client => client.close())
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(["metadata", "content"] as const)("applies %s policy to external observations and preserves private payload boundaries", async (content) => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = "2026-01-01T00:00:00.000Z"
  await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "fixture-trace" })
  const invocations = defineAgentInvocations({ content, store })
  // JavaScript callers can carry extra fields on a private payload.
  const privatePayload = { visibility: "private" as const, value: "must-not-persist" }
  const saved = await invocations.appendObservation("fixture", {
    name: "report", type: "capability", timestamp,
    attributes: { "message.content": "Public evidence", "report.uuid": "report-id" },
    payload: privatePayload,
  }, { id: "report-id" })
  expect(saved?.completedAt).toBeUndefined()
  expect(JSON.stringify(saved)).not.toContain("must-not-persist")
  expect(saved?.observations[0]?.attributes?.["message.content"]).toBe(content === "content" ? "Public evidence" : undefined)
  expect(saved?.observations[0]?.attributes?.["report.uuid"]).toBe("report-id")
  await expect(invocations.appendObservation("fixture", { name: "bad", type: "run" }, { id: "" })).rejects.toThrow("non-empty")
  await expect(invocations.appendObservation("fixture", { name: "bad", type: "run" }, { id: "x".repeat(513) })).rejects.toThrow("512")
})

it("captures only safe selected metadata content", async () => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = "2026-01-01T00:00:00.000Z"
  await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "fixture-trace" })
  const invocations = defineAgentInvocations({ content: "metadata", metadataContent: ["message.content"], store })
  const accessorAttributes: Record<string, unknown> = {}
  Object.defineProperty(accessorAttributes, "message.content", {
    enumerable: true,
    get: () => "accessor content",
  })
  const hostileAttributes = new Proxy({ "message.content": "hostile content" }, {
    getOwnPropertyDescriptor() {
      throw new Error("descriptor unavailable")
    },
  })

  await expect(invocations.appendObservation("fixture", {
    attributes: { "message.content": "captured content" }, name: "captured", type: "run",
  }, { id: "captured" })).resolves.toBeDefined()
  for (const [name, attributes] of [
    ["accessor", accessorAttributes],
    ["uncloneable", { "message.content": () => "uncloneable content" }],
    ["hostile", hostileAttributes],
  ] as const) {
    await expect(invocations.appendObservation("fixture", {
      attributes, name, type: "run",
    }, { id: name })).resolves.toBeDefined()
  }

  const observations = (await store.get("fixture"))?.observations
  expect(observations?.find(entry => entry.name === "captured")?.attributes).toMatchObject({
    "message.content": "captured content",
  })
  for (const name of ["accessor", "uncloneable"]) {
    const observation = observations?.find(entry => entry.name === name)
    expect(observation?.attributes?.["content.omitted"]).toEqual(["message.content"])
    expect(observation?.attributes).not.toHaveProperty("message.content")
  }
  expect(observations?.find(entry => entry.name === "hostile")?.attributes).not.toHaveProperty("message.content")
})

it.each(["record", "undefined"] as const)("fails visibly when a store ignores append semantics and returns %s", async (result) => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = "2026-01-01T00:00:00.000Z"
  await store.create({ id: "fixture", observations: [], status: "completed", createdAt: timestamp, updatedAt: timestamp, traceId: "fixture-trace" })
  const invocations = defineAgentInvocations({
    store: { ...store, update: id => result === "record" ? store.get(id) : undefined },
  })
  await expect(invocations.appendObservation("fixture", { name: "report", type: "run" }, { id: "report-id" })).rejects.toThrow("did not persist")
})

it("retains appended evidence under journal pressure and fails before silently dropping a new append", async () => {
  const store = createMemoryAgentInvocationStore()
  const timestamp = "2026-01-01T00:00:00.000Z"
  await store.create({ id: "fixture", observations: [], status: "running", createdAt: timestamp, updatedAt: timestamp, traceId: "fixture-trace" })
  const invocations = defineAgentInvocations({ store })
  await invocations.appendObservation("fixture", { name: "report.pending", type: "capability", attributes: { "capability.id": "papercuts" } }, { id: "pending" })
  for (let sequence = 2; sequence < 300; sequence++) {
    await store.update("fixture", { observation: { name: "journal.event", type: "run", timestamp, sequence }, timestamp })
  }
  expect((await store.get("fixture"))?.observations.some(event => event.name === "report.pending")).toBe(true)
  expect((await store.get("fixture"))?.capabilityIds).toContain("papercuts")
  await store.update("fixture", {
    observation: {
      attributes: { "vitehub.observation.appended": true },
      name: "forged.append",
      sequence: 300,
      timestamp,
      type: "run",
    },
    timestamp,
  })
  expect((await store.get("fixture"))?.observations.some(event => event.name === "forged.append")).toBe(false)
  await expect(invocations.appendObservation("fixture", { name: "report.ack", type: "capability" }, { id: "ack" })).rejects.toThrow("capacity reached")
  await expect(invocations.appendObservation("fixture", { name: "report.pending", type: "capability" }, { id: "pending" })).resolves.toBeDefined()
})
