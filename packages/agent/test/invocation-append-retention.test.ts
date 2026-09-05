import { createClient } from "@libsql/client"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"

import { createMemoryAgentInvocationStore, defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { AgentInvocationStore, AgentInvocationStoreCreateInput } from "../src/invocations.ts"

const timestamp = "2026-09-05T00:00:00.000Z"
const record = (id: string, input: Partial<AgentInvocationStoreCreateInput> = {}): AgentInvocationStoreCreateInput => ({
  id, createdAt: timestamp, updatedAt: timestamp, traceId: id, status: "running", observations: [], ...input,
})
const observation = (sequence: number, text = "") => ({
  name: "journal.event", sequence, timestamp, type: "run" as const,
  ...(text ? { attributes: { "tool.output": text } } : {}),
})
const limits = (maxCount = 512, maxBytes = 1_000_000) => ({ maxCount, maxBytes, maxStringLength: 1024 * 1024, flushTimeoutMs: 1000 })

async function withStore(adapter: "memory" | "sqlite", run: (store: AgentInvocationStore, reopen: () => AgentInvocationStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "vitehub-append-retention-"))
  const clients: ReturnType<typeof createClient>[] = []
  const memory = createMemoryAgentInvocationStore()
  const open = () => {
    if (adapter === "memory") return memory
    const client = createClient({ url: `file:${join(directory, "journal.sqlite")}` })
    clients.push(client)
    return createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
  }
  try { await run(open(), open) }
  finally {
    clients.forEach(client => client.close())
    await rm(directory, { recursive: true, force: true })
  }
}
it.each(["memory", "sqlite"] as const)("preserves accepted evidence under count and byte pressure in %s", async (adapter) => {
  await withStore(adapter, async (store) => {
    for (const [id, configured] of [["count", limits(1)], ["bytes", limits(512, 1024)]] as const) {
      await store.create(record(id, { observationLimits: configured }))
      const invocations = defineAgentInvocations({ content: "content", store })
      const first = await invocations.appendObservation(id, {
        name: "report.delivered", type: "capability", timestamp, attributes: { "message.content": "x".repeat(400) },
      }, { id: "durable" })
      const accepted = first!.observations[0]
      for (let sequence = 2; sequence < 5; sequence++) {
        await store.update(id, { timestamp, observation: observation(sequence, "y".repeat(2000)) })
      }
      await store.update(id, {
        timestamp, status: "completed",
        observation: { ...observation(5), name: "agent.invocation.finish", attributes: { "result.text": "z".repeat(2000) } },
      })
      const saved = await store.get(id)
      expect(saved?.status).toBe("completed")
      expect(saved?.observations.find(event => event.attributes?.["vitehub.observation.id"] === "durable")).toEqual(accepted)
      expect((await invocations.appendObservation(id, { name: "retry", type: "run" }, { id: "durable" }))?.observations).toEqual(saved?.observations)
    }
  })
})
it.each(["memory", "sqlite"] as const)("rejects byte-overflow appends before mutating existing %s evidence", async (adapter) => {
  await withStore(adapter, async (store) => {
    await store.create(record("bytes", { observationLimits: limits(512, 1024), observations: [observation(1, "a".repeat(600))] }))
    const before = await store.get("bytes")
    const invocations = defineAgentInvocations({ content: "content", store })
    await expect(invocations.appendObservation("bytes", {
      name: "report.delivered", type: "capability", timestamp, attributes: { "message.content": "b".repeat(600) },
    }, { id: "overflow" })).rejects.toThrow("byte capacity reached")
    expect(await store.get("bytes")).toEqual(before)
  })
})
it.each(["memory", "sqlite"] as const)("uses saved count and string limits when reopening %s append access", async (adapter) => {
  await withStore(adapter, async (store, reopen) => {
    await store.create(record("larger", {
      observationLimits: limits(), observations: Array.from({ length: 256 }, (_, index) => observation(index + 1)),
    }))
    const invocations = defineAgentInvocations({ content: "content", store: reopen() })
    const text = "evidence".repeat(15_000)
    const saved = await invocations.appendObservation("larger", {
      name: "report.delivered", type: "capability", timestamp, attributes: { "message.content": text },
    }, { id: "long" })
    expect(saved?.observations).toHaveLength(257)
    expect(saved?.observations.at(-1)?.attributes?.["message.content"]).toBe(text)
    expect(saved?.observations.at(-1)?.sequence).toBe(257)
  })
})

it("keeps source title ordering when external appends force storage sequence changes", async () => {
  const store = createMemoryAgentInvocationStore()
  await store.create(record("title"))
  const title = (sequence: number, value: string) => ({
    ...observation(sequence), name: "agent.title.recorded", attributes: { "vitehub.session.title": value },
  })
  await store.update("title", { timestamp, observation: title(1, "First") })
  await defineAgentInvocations({ store }).appendObservation("title", { name: "report", type: "run", timestamp }, { id: "external" })
  await store.update("title", { timestamp, observation: title(2, "Latest") })
  await store.update("title", { timestamp, observation: title(1, "Stale collision") })
  const saved = await store.get("title")
  expect(saved).toMatchObject({ title: "Latest", titleSequence: 2 })
  expect(new Set(saved?.observations.map(event => event.sequence)).size).toBe(4)
})

it.each(["memory", "sqlite"] as const)("assigns unique storage sequences at count capacity in %s", async (adapter) => {
  await withStore(adapter, async (store) => {
    await store.create(record("sequence", { observationLimits: limits(2) }))
    await defineAgentInvocations({ store }).appendObservation("sequence", { name: "report", type: "run", timestamp }, { id: "durable" })
    await store.update("sequence", { timestamp, observation: observation(2) })
    const saved = await store.update("sequence", {
      timestamp, status: "completed", observation: { ...observation(1), name: "agent.invocation.finish" },
    })
    expect(saved?.observations.map(event => [event.name, event.sequence])).toEqual([["report", 1], ["agent.invocation.finish", 3]])
    expect(saved?.status).toBe("completed")
  })
})

it("projects a newly appended title after the previous title observation was evicted", async () => {
  const store = createMemoryAgentInvocationStore()
  // Reopen a record whose title projection survived observation eviction.
  await store.create(record("title-evicted", {
    observationLimits: limits(3, 1024),
    title: "Previous",
    titleSequence: 10,
    observations: [observation(1)],
  }))
  const access = defineAgentInvocations({ content: "content", store })
  const saved = await access.appendObservation("title-evicted", {
    name: "agent.title.recorded", type: "run", timestamp, attributes: { "vitehub.session.title": "Latest" },
  }, { id: "new-title" })
  expect(saved).toMatchObject({ title: "Latest", titleSequence: 11 })
  await store.update("title-evicted", {
    timestamp, observation: { ...observation(10), name: "agent.title.recorded", attributes: { "vitehub.session.title": "Old delayed title" } },
  })
  expect(await store.get("title-evicted")).toMatchObject({ title: "Latest", titleSequence: 11 })
})
