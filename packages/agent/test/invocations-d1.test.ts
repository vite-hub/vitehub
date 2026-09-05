import { Miniflare } from "miniflare"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { bindAgentInvocations, defineAgentInvocations } from "../src/invocations.ts"
import { createD1AgentInvocationStore, d1AgentInvocationSchema } from "../src/invocations/d1.ts"

import type { AgentInvocationD1Database, D1AgentInvocationStoreOptions } from "../src/invocations/d1.ts"
import type { AgentInvocationStoreCreateInput } from "../src/invocations.ts"

const timestamp = new Date().toISOString()
const invocation = (id: string, input: Partial<AgentInvocationStoreCreateInput> = {}): AgentInvocationStoreCreateInput => ({
  createdAt: timestamp,
  id,
  observations: [],
  status: "pending",
  traceId: `trace:${id}`,
  updatedAt: timestamp,
  ...input,
})
const observation = (id: number) => ({
  attributes: { "vitehub.observation.id": `event:${id}`, "capability.id": "search" },
  name: "agent.tool.call",
  sequence: id,
  timestamp,
  type: "run" as const,
})

describe("D1 Agent Invocation store", () => {
  let miniflare: Miniflare
  let database: AgentInvocationD1Database
  let tablePrefix: string
  let sequence = 0
  const store = (options: Partial<D1AgentInvocationStoreOptions> = {}) => createD1AgentInvocationStore({ database, tablePrefix, ...options })

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    database = await miniflare.getD1Database("DB")
  })
  beforeEach(async () => {
    tablePrefix = `test_${++sequence}_`
    await database.batch(d1AgentInvocationSchema({ tablePrefix }).map(sql => database.prepare(sql)))
  })
  afterAll(async () => { await miniflare?.dispose() })

  it("requires an explicit migration and resolves the request binding once per operation", async () => {
    const resolve = vi.fn(() => database)
    const journal = store({ database: resolve, tablePrefix: "unmigrated_" })
    expect(resolve).not.toHaveBeenCalled()
    await expect(journal.get("missing")).rejects.toThrow(/no such table/)
    await database.batch(d1AgentInvocationSchema({ tablePrefix: "unmigrated_" }).map(sql => database.prepare(sql)))
    await journal.create(invocation("one"))
    await journal.update("one", { status: "running", timestamp })
    expect(resolve).toHaveBeenCalledTimes(3)
    expect((await journal.get("one"))?.status).toBe("running")
  })

  it("runs the Agent journal lifecycle through a request-resolved D1 store", async () => {
    const persisted = store({ database: () => database })
    const invocations = defineAgentInvocations({ store: persisted })
    const journal = await bindAgentInvocations(invocations, {
      memo: vi.fn(),
      run: { runId: "telegram:meal" },
      runtime: "unknown",
      waitUntil: vi.fn(),
    }, { agentName: "calories" })
    expect(journal).toBeDefined()
    if (!journal) throw new Error("Expected a configured journal")
    try {
      await journal.running()
      await journal.context.traceLog?.append({ attributes: { "capability.id": "meals" }, name: "agent.tool.call", type: "run" })
    }
    finally {
      await journal.finish("completed")
    }
    const result = await invocations.getByRunId("telegram:meal", "calories")
    expect(result).toMatchObject({ agentName: "calories", capabilityIds: ["meals"], status: "completed" })
    expect(result?.observations.some(event => event.name === "agent.tool.call")).toBe(true)
    expect(await persisted.getClaimToken(result!.id)).toBeUndefined()
    expect((await invocations.list({ agentName: "calories" })).invocations).toHaveLength(1)
  })

  it("creates once across independent stores and retains the same cursor after reopening", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store().create(invocation("one"))))
    expect(results.filter(result => result.created)).toHaveLength(1)
    expect(new Set(results.map(result => result.record.cursor)).size).toBe(1)
    expect(await store().get("one")).toEqual(results[0]!.record)
    expect(await store().create(invocation("one", { agentName: "changed" }))).toEqual({ created: false, record: results[0]!.record })
  })

  it("stores bigint trace attributes without losing the journal", async () => {
    const journal = store()
    await journal.create(invocation("one", { observations: [{ ...observation(1), attributes: { value: 42n } }] }))
    expect((await journal.get("one"))?.observations[0]?.attributes?.value).toBe("42")
  })

  it("persists session titles in records, summaries and search", async () => {
    const journal = store()
    await journal.create(invocation("one"))
    await journal.update("one", {
      observation: { ...observation(1), name: "agent.title.recorded", attributes: { "vitehub.session.title": "Meal review" } },
      timestamp,
    })
    expect((await journal.get("one"))?.title).toBe("Meal review")
    expect((await journal.getSummary?.("one"))?.title).toBe("Meal review")
    expect((await journal.list({ search: "Meal review" })).invocations.map(item => item.id)).toEqual(["one"])
  })

  it("uses one claim winner, refreshes tokens, checks takeover tokens and releases only the owner", async () => {
    const journal = store()
    await journal.create(invocation("one"))
    const claims = await Promise.all([store().claim("one", "a", 30_000), store().claim("one", "b", 30_000)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const owner = claims[0] ? "a" : "b"
    const token = await journal.getClaimToken("one")
    expect(await journal.claim("one", owner, 30_000)).toBe(true)
    expect(await journal.getClaimToken("one")).not.toBe(token)
    expect(await journal.claim("one", "new", 30_000, { replaceClaimToken: token })).toBe(false)
    await journal.release("one", "wrong")
    expect(await journal.claim("one", "new", 30_000)).toBe(false)
    expect(await journal.claim("one", "new", 30_000, { replaceClaimToken: await journal.getClaimToken("one") })).toBe(true)
    expect(await journal.update("one", { status: "failed", timestamp }, owner)).toBeUndefined()
    await journal.release("one", "new")
    expect(await journal.getClaimToken("one")).toBeUndefined()
    expect(await journal.claim("missing", "new", 30_000)).toBe(false)
  })

  it("takes over expired leases and supports explicit forced takeover", async () => {
    const journal = store()
    await journal.create(invocation("one"))
    await journal.claim("one", "old", 30_000)
    await database.prepare(`UPDATE ${tablePrefix}invocations SET claim_expires_at = 0 WHERE id = ?`).bind("one").all()
    expect(await journal.claim("one", "new", 30_000)).toBe(true)
    expect(await journal.claim("one", "forced", 30_000, { replaceExisting: true })).toBe(true)
  })

  it("preserves concurrent observations and retry identity across independent stores", async () => {
    await store().create(invocation("one"))
    await Promise.all(Array.from({ length: 4 }, (_, id) => store().update("one", { observation: observation(id), timestamp })))
    await store().update("one", { observation: observation(3), timestamp })
    const result = await store().get("one")
    expect(result?.observations.map(event => event.sequence)).toEqual(Array.from({ length: 4 }, (_, id) => id))
    expect(result?.capabilityIds).toEqual(["search"])
  })

  it("fences an update when ownership changes between its read and write", async () => {
    const journal = store()
    await journal.create(invocation("one"))
    await journal.claim("one", "old", 30_000)
    let takeover = true
    const interrupted: AgentInvocationD1Database = {
      prepare: query => database.prepare(query),
      async batch(statements) {
        if (takeover) {
          takeover = false
          await journal.claim("one", "new", 30_000, { replaceExisting: true })
        }
        return database.batch(statements)
      },
    }
    expect(await store({ database: interrupted }).update("one", { status: "failed", timestamp }, "old")).toBeUndefined()
    expect((await journal.get("one"))?.status).toBe("pending")
  })

  it("does not update a replacement record after retention removes the original", async () => {
    const journal = store({ maxRecords: 1 })
    await journal.create(invocation("one"))
    await journal.create(invocation("keeper", { status: "completed" }))
    let replace = true
    const interrupted: AgentInvocationD1Database = {
      prepare: query => database.prepare(query),
      async batch(statements) {
        if (replace) {
          replace = false
          await journal.update("one", { status: "completed", timestamp })
          expect(await journal.get("one")).toBeUndefined()
          await journal.create(invocation("one", { agentName: "replacement" }))
        }
        return database.batch(statements)
      },
    }
    expect(await store({ database: interrupted }).update("one", { status: "failed", timestamp })).toBeUndefined()
    expect(await journal.get("one")).toMatchObject({ agentName: "replacement", status: "pending" })
  })

  it("fails visibly after bounded contention", async () => {
    const journal = store()
    await journal.create(invocation("one"))
    let attempts = 0
    const contended: AgentInvocationD1Database = {
      prepare: query => database.prepare(query),
      async batch(statements) {
        attempts++
        await journal.claim("one", "owner", 30_000)
        return database.batch(statements)
      },
    }
    await expect(store({ database: contended }).update("one", { status: "running", timestamp })).rejects.toThrow(/32 concurrent write retries/)
    expect(attempts).toBe(32)
    expect((await journal.get("one"))?.status).toBe("pending")
  }, 30_000)

  it("rolls back record updates if a batch statement fails", async () => {
    await store().create(invocation("one"))
    const failing: AgentInvocationD1Database = {
      prepare: query => database.prepare(query),
      batch: statements => database.batch([...statements, database.prepare("INSERT INTO missing_table VALUES (1)")]),
    }
    await expect(store({ database: failing }).update("one", { status: "completed", timestamp })).rejects.toThrow()
    expect((await store().get("one"))?.status).toBe("pending")
  })

  it("pages summaries and filters Agent, Capability, status and literal search", async () => {
    const journal = store()
    await journal.create(invocation("one", { agentName: "alpha", annotations: { label: "100%_done" }, observations: [observation(1)] }))
    await journal.create(invocation("two", { agentName: "beta", capabilityIds: ["files"] }))
    await journal.create(invocation("three", { agentName: "alpha" }))
    const first = await journal.list({ limit: 2 })
    expect(first.invocations.map(item => item.id)).toEqual(["three", "two"])
    expect(first.invocations.every(item => !("observations" in item))).toBe(true)
    expect((await journal.list({ cursor: first.cursor, limit: 2 })).invocations.map(item => item.id)).toEqual(["one"])
    expect((await journal.list({ agentName: "alpha", capabilityId: "search", status: "pending", search: "100%_done" })).invocations.map(item => item.id)).toEqual(["one"])
    expect(await journal.listAgentNames?.()).toEqual(["alpha", "beta"])
    expect(await journal.listCapabilityIds?.()).toEqual(["files", "search"])
    expect(await journal.listCapabilityIds?.("alpha")).toEqual(["search"])
    expect(await journal.getSummary?.("one")).not.toHaveProperty("observations")
    expect(await journal.list({ status: [] })).toEqual({ invocations: [] })
  })

  it("prunes terminal records and their claims while retaining active records", async () => {
    const journal = store({ maxRecords: 1, maxAgeMs: false })
    await journal.create(invocation("active", { updatedAt: "2000-01-01T00:00:00.000Z" }))
    await journal.claim("active", "owner", 30_000)
    await journal.create(invocation("old"))
    await journal.claim("old", "owner", 30_000)
    await journal.update("old", { status: "completed", timestamp }, "owner")
    await journal.create(invocation("new", { status: "completed" }))
    expect(await journal.get("old")).toBeUndefined()
    expect(await journal.getClaimToken("old")).toBeUndefined()
    expect(await journal.get("active")).toBeDefined()
    expect(await journal.getClaimToken("active")).toBeDefined()
    expect(await journal.get("new")).toBeDefined()
  })

  it("applies age retention and permits both retention limits to be disabled", async () => {
    await store({ maxAgeMs: false, maxRecords: false }).create(invocation("old", { status: "completed", updatedAt: "2000-01-01T00:00:00.000Z" }))
    expect(await store().get("old")).toBeDefined()
    await store().create(invocation("new"))
    expect(await store().get("old")).toBeUndefined()
  })

  it("caps long content journals to the D1 row budget and persists their terminal outcome", async () => {
    const persistence = store()
    const failures: unknown[] = []
    const invocations = defineAgentInvocations({
      content: "content",
      observations: { maxBytes: 16 * 1024 * 1024, maxStringLength: 1024 * 1024, flushTimeoutMs: 10_000 },
      store: {
        ...persistence,
        async update(id, input, claimId) {
          try { return await persistence.update(id, input, claimId) }
          catch (error) { failures.push(error); throw error }
        },
      },
    })
    const journal = await bindAgentInvocations(invocations, {
      memo: vi.fn(), run: { runId: "large-content" }, runtime: "unknown", waitUntil: vi.fn(),
    })
    if (!journal) throw new Error("Expected a configured journal")
    try {
      await journal.running()
      for (let index = 0; index < 4; index++) {
        await journal.context.traceLog!.append({
          name: "tool.output", type: "run", attributes: { "tool.output": "x".repeat(700_000), index },
        })
      }
      await journal.context.traceLog!.append({ name: "agent.invocation.finish", type: "run" })
    }
    finally { await journal.finish("completed") }
    // Large local D1 round trips can use the journal's bounded background terminal recovery.
    await vi.waitFor(async () => {
      expect((await invocations.getByRunId("large-content"))?.status).toBe("completed")
    }, { timeout: 15_000 })
    expect(failures).toEqual([])
    const saved = await invocations.getByRunId("large-content")
    expect(saved).toMatchObject({ status: "completed", observationsTruncated: true, observationLimits: { maxBytes: 1_000_000 } })
    expect(saved?.observations.some(event => event.name === "agent.invocation.finish")).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(saved?.observations)).byteLength).toBeLessThanOrEqual(1_000_000)
    const result = await database.prepare(`SELECT length(CAST(record AS BLOB)) + length(CAST(summary AS BLOB)) + length(CAST(search AS BLOB)) AS bytes FROM ${tablePrefix}invocations WHERE id = ?`).bind(saved!.id).all<{ bytes: number }>()
    expect(result.results[0]!.bytes).toBeLessThanOrEqual(1_900_000)
  }, 30_000)

  it("checks duplicated metadata before writing and keeps terminal status when observations must be removed", async () => {
    const journal = store()
    await journal.create(invocation("large-metadata", {
      annotations: { label: "m".repeat(600_000) },
      observationLimits: { maxBytes: 16 * 1024 * 1024, maxStringLength: 1024 * 1024, maxCount: 256, flushTimeoutMs: 1000 },
    }))
    const saved = await journal.update("large-metadata", {
      timestamp, status: "failed",
      observation: { ...observation(1), name: "agent.invocation.finish", attributes: { "result.text": "x".repeat(800_000) } },
    })
    expect(saved).toMatchObject({ status: "failed", observationsTruncated: true })
    expect(saved?.observations).toEqual([])
    expect(saved?.annotations?.label).toHaveLength(600_000)
    await expect(journal.create(invocation("oversize", { annotations: { label: "m".repeat(1_000_000) } }))).rejects.toThrow(/metadata exceeds the row byte limit/)
    expect(await journal.get("oversize")).toBeUndefined()
  }, 15_000)

  it("appends concurrent evidence without taking the live Agent claim", async () => {
    const journal = store()
    await journal.create(invocation("appends"))
    await journal.claim("appends", "live-owner", 30_000)
    const claim = await journal.getClaimToken("appends")
    await Promise.all(Array.from({ length: 4 }, (_, index) => defineAgentInvocations({ store: store() }).appendObservation(
      "appends", { name: "report.delivered", type: "run", timestamp }, { id: `report:${index}` },
    )))
    const access = defineAgentInvocations({ store: journal })
    const saved = await access.appendObservation("appends", { name: "retry", type: "run", timestamp }, { id: "report:0" })
    expect(saved?.observations).toHaveLength(4)
    expect(new Set(saved?.observations.map(event => event.sequence)).size).toBe(4)
    expect(await journal.getClaimToken("appends")).toBe(claim)
  }, 15_000)

  it("rejects full-row append overflow without mutation and keeps accepted appends during later pruning", async () => {
    const journal = store()
    await journal.create(invocation("row-appends", {
      annotations: { label: "m".repeat(600_000) },
      observationLimits: { maxBytes: 1_000_000, maxStringLength: 1024 * 1024, maxCount: 256, flushTimeoutMs: 1000 },
      observations: [{ ...observation(1), attributes: { "tool.output": "x".repeat(100_000) } }],
    }))
    const before = await journal.get("row-appends")
    const access = defineAgentInvocations({ content: "content", store: journal })
    await expect(access.appendObservation("row-appends", {
      name: "report.delivered", type: "run", timestamp, attributes: { "message.content": "y".repeat(700_000) },
    }, { id: "too-large" })).rejects.toThrow("row byte capacity reached")
    expect(await journal.get("row-appends")).toEqual(before)
    const appended = await access.appendObservation("row-appends", { name: "report.pending", type: "run", timestamp }, { id: "accepted" })
    const accepted = appended?.observations.find(event => event.attributes?.["vitehub.observation.id"] === "accepted")
    const saved = await journal.update("row-appends", {
      timestamp, status: "completed",
      observation: { ...observation(3), name: "agent.invocation.finish", attributes: { "result.text": "z".repeat(800_000) } },
    })
    expect(saved).toMatchObject({ status: "completed", observationsTruncated: true })
    expect(saved?.observations).toEqual([accepted])
  }, 20_000)

  it("validates table identifiers, retention, paging and leases", async () => {
    expect(() => d1AgentInvocationSchema({ tablePrefix: "unsafe;" })).toThrow(/identifier/)
    expect(() => store({ maxRecords: 0 })).toThrow(/retention/)
    expect(() => store({ maxAgeMs: Infinity })).toThrow(/retention/)
    await expect(store().list({ cursor: "01" })).rejects.toThrow(/cursor/)
    await expect(store().list({ limit: 0 })).rejects.toThrow(/limit/)
    await expect(store().list({ search: "x".repeat(257) })).rejects.toThrow(/search/)
    await expect(store().claim("one", "owner", 0)).rejects.toThrow(/leaseMs/)
    await expect(store().claim("one", "x".repeat(513), 30_000)).rejects.toThrow(/claimId/)
  })
})
