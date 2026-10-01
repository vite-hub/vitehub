import { runAgent } from "@vite-hub/agent"
import { eq } from "drizzle-orm"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest"

import { defineAgent } from "../src/agent.ts"
import { installConsoleAgentDefinitions } from "../src/console/runtime/server/agents.ts"
import { console as consoleRuntime } from "../src/console/server.ts"
import { createConsoleD1Invocations, getConsoleInvocations, getConsoleUsageIndex, installConsoleInvocations } from "../src/console/runtime/server/invocations.ts"

import usageHandler from "../src/console/runtime/server/usage.get.ts"

import type { AgentInvocationD1Database, AgentInvocationD1Statement } from "@vite-hub/agent/invocations/d1"

describe("Console D1 journal", () => {
  let miniflare: Miniflare
  let database: AgentInvocationD1Database

  beforeAll(async () => {
    miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB", "OTHER", "USAGE", "USAGE_OTHER"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    database = await miniflare.getD1Database("DB")
  })
  afterAll(async () => { await miniflare?.dispose() })

  it("journals Agents without their own journal into the Worker D1 binding and creates the table", { timeout: 30_000 }, async () => {
    const env = vi.fn(async () => ({ DB: database }))
    const agent = defineAgent({ driver: { run: () => "done" }, name: "labeller", runtime: false })
    installConsoleAgentDefinitions([{ definition: agent, fallbackName: "labeller" }], {
      d1: { binding: "DB", env },
      projectRoot: "/console-d1-journal-test",
    })
    const invocations = agent.invocations
    if (!invocations) throw new Error("Expected the Console journal fallback.")
    const context = { memo: vi.fn(), run: { runId: "d1-default" }, runtime: "unknown", waitUntil: vi.fn() }
    const journalDatabase = consoleRuntime.resolve(context).invocations
    if (journalDatabase.driver !== "d1") throw new Error("Expected the D1 Console database.")
    const { db, schema } = journalDatabase
    expectTypeOf<typeof schema.invocations.$inferInsert["search"]>().toEqualTypeOf<string>()
    expectTypeOf<typeof schema.invocations.$inferInsert["summary"]>().toEqualTypeOf<NonNullable<typeof schema.invocations.$inferInsert["summary"]>>()
    expect(schema.invocations.search.notNull).toBe(true)
    expect(schema.invocations.summary.notNull).toBe(true)
    // The database is usable before the first invocation write and initializes its schema.
    await expect(db.select().from(schema.invocations)).resolves.toEqual([])
    await expect(db.select().from(schema.invocations).get()).resolves.toBeUndefined()

    await expect(runAgent(agent, { memo: vi.fn(), run: { runId: "d1-default" }, runtime: "unknown", waitUntil: vi.fn() }, {})).resolves.toBe("done")

    // Each journal write is bounded to one second and retried in the background, so wait for the terminal state.
    await vi.waitFor(async () => {
      await expect(invocations.getByRunId("d1-default", "labeller")).resolves.toMatchObject({ agentName: "labeller", status: "completed" })
    }, { timeout: 20_000 })
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vitehub_agent_invocations'").all()
    expect(tables.results).toHaveLength(1)
    const summary = await invocations.getByRunId("d1-default", "labeller")
    if (!summary) throw new Error("Expected the completed invocation.")
    const query = db.select().from(schema.invocations).where(eq(schema.invocations.id, summary.id))
    await expect(query.all()).resolves.toMatchObject([{ id: summary.id, agentName: "labeller", status: "completed", record: { id: summary.id } }])
    await expect(query.get()).resolves.toMatchObject({ id: summary.id, status: "completed" })
    await expect(db.query.invocations.findFirst({ where: eq(schema.invocations.id, summary.id) })).resolves.toMatchObject({ id: summary.id, status: "completed" })
    expect(env).toHaveBeenCalled()
  })

  it("resolves the D1 binding per Drizzle operation and initializes each database", async () => {
    let active = await miniflare.getD1Database("OTHER")
    installConsoleInvocations("/console-d1-request-bindings", undefined, undefined, undefined, {
      binding: "JOURNAL",
      env: async () => ({ JOURNAL: active }),
    })
    const journalDatabase = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    if (journalDatabase.driver !== "d1") throw new Error("Expected the D1 Console database.")
    const { db, schema } = journalDatabase
    const record = {
      agentName: "binding-test",
      createdAt: "2026-09-30T00:00:00.000Z",
      id: "binding-marker",
      observations: [],
      status: "completed" as const,
      traceId: "binding-trace",
      updatedAt: "2026-09-30T00:00:00.000Z",
    }
    await db.insert(schema.invocations).values({ id: record.id, status: record.status, agentName: record.agentName, search: "", summary: record, updatedAt: record.updatedAt, record }).run()
    const query = db.select().from(schema.invocations).where(eq(schema.invocations.id, record.id))
    await expect(query.all()).resolves.toMatchObject([{ record }])
    await expect(db.batch([query])).resolves.toMatchObject([[{ record }]])
    await expect(db.batch([
      db.update(schema.invocations).set({ agentName: "rolled-back" }).where(eq(schema.invocations.id, record.id)),
      db.insert(schema.invocations).values({ id: record.id, status: record.status, agentName: record.agentName, search: "", summary: record, updatedAt: record.updatedAt, record }),
    ])).rejects.toThrow()
    await expect(query.all()).resolves.toMatchObject([{ agentName: record.agentName }])
    active = await miniflare.getD1Database("DB")
    await expect(query.all()).resolves.toEqual([])
    active = await miniflare.getD1Database("OTHER")
    await expect(query.all()).resolves.toMatchObject([{ record }])
  })

  it(
    "projects D1 usage in bounded pages without fetching transcripts and tracks writes and binding changes",
    { timeout: 30_000 },
    async () => {
      const usageDatabase = await miniflare.getD1Database("USAGE")
      let active = usageDatabase
      const invocations = createConsoleD1Invocations({
        binding: "DB",
        env: () => ({ DB: active }),
      })
      await invocations.list()
      const index = getConsoleUsageIndex(invocations)
      if (!index) throw new Error("Expected a D1 usage index.")
      const get = vi
        .spyOn(invocations, "get")
        .mockRejectedValue(new Error("Usage must not load transcripts."))
      const now = "2026-09-30T00:00:00.000Z"
      const record = (id: string, usd = "0.1") => ({
        id,
        agentName: "usage-test",
        traceId: id,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        annotations: { "agent.model.id": "model" },
        observations: [
          {
            name: "agent.invocation.finish",
            attributes: {
              "usage.record": {
                cost: { usd },
                usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
              },
            },
          },
        ],
      })
      await active.batch(
        Array.from({ length: 251 }, (_, i) => {
          const value = record(`usage-${i}`)
          return active
            .prepare(
              `INSERT INTO vitehub_agent_invocations(id,status,agent_name,search,summary,updated_at,record) VALUES (?,?,?,?,?,?,?)`,
            )
            .bind(
              value.id,
              value.status,
              value.agentName,
              "",
              JSON.stringify(value),
              now,
              JSON.stringify(value),
            )
        }),
      )
      expect(await index.query({ now })).toMatchObject({
        projection: { complete: false, pending: 1 },
        partial: true,
        totals: { invocations: 250, costUsd: "25" },
        sessions: expect.any(Array),
      })
      const complete = await index.query({ now })
      expect(complete).toMatchObject({
        projection: { complete: true, pending: 0 },
        totals: { invocations: 251, costUsd: "25.1", totalTokens: 1255 },
      })
      expect(complete.sessions).toHaveLength(50)
      expect(complete.cursor).toEqual(expect.any(String))
      await active
        .prepare("UPDATE vitehub_agent_invocations SET record = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(record("usage-0", "0.2")), now, "usage-0")
        .all()
      expect(await index.query({ now })).toMatchObject({
        totals: { invocations: 251, costUsd: "25.2" },
      })
      await active
        .prepare("DELETE FROM vitehub_agent_invocations WHERE id = ?")
        .bind("usage-0")
        .all()
      expect(await index.query({ now })).toMatchObject({
        totals: { invocations: 250, costUsd: "25" },
      })
      active = await miniflare.getD1Database("USAGE_OTHER")
      expect(await index.query({ now })).toMatchObject({
        projection: { complete: true, pending: 0 },
        totals: { invocations: 0 },
      })
      active = usageDatabase
      expect(await index.query({ now })).toMatchObject({
        totals: { invocations: 250, costUsd: "25" },
      })
      expect(get).not.toHaveBeenCalled()
    },
  )

  it("does not share pending D1 usage reads across requests", async () => {
    let release: (() => void) | undefined
    const ready = new Promise<void>(resolve => { release = resolve })
    const env = vi.fn(async () => {
      await ready
      return { DB: database }
    })
    installConsoleInvocations("/console-d1-usage-cache", undefined, undefined, undefined, { binding: "DB", env })
    const request = () => usageHandler({ method: "GET", req: { url: "http://localhost/api/_vitehub/console/usage" } })
    const requests = [request(), request()]
    try {
      await vi.waitFor(() => expect(env).toHaveBeenCalledTimes(2))
    } finally {
      release?.()
      await Promise.all(requests)
    }
    const calls = env.mock.calls.length
    await request()
    expect(env).toHaveBeenCalledTimes(calls)
  })

  it.each(["update", "delete"])("keeps newer cached D1 usage when an older response finishes after an %s", { timeout: 30_000 }, async (change) => {
    installConsoleInvocations(`/console-d1-usage-order-${change}`, undefined, undefined, undefined, {
      binding: "DB", env: () => ({ DB: database }),
    })
    const invocations = getConsoleInvocations()
    const index = getConsoleUsageIndex(invocations)
    if (!index) throw new Error("Expected a D1 usage index.")
    const journalDatabase = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    if (journalDatabase.driver !== "d1") throw new Error("Expected the D1 Console database.")
    const { db, schema } = journalDatabase
    const now = new Date().toISOString()
    const observation = (totalTokens: number) => ({
      name: "agent.invocation.finish", type: "lifecycle" as const, sequence: 1, timestamp: now,
      attributes: { "usage.record": { usage: { totalTokens } } },
    })
    const record = {
      id: `usage-order-${change}`, agentName: `usage-order-${change}`, traceId: `usage-order-${change}`,
      status: "completed" as const, createdAt: now, updatedAt: now, completedAt: now,
      observations: [observation(5)],
    }
    await db.insert(schema.invocations).values({ id: record.id, status: record.status, agentName: record.agentName, search: "", summary: record, updatedAt: now, record }).run()
    const request = () => usageHandler({ method: "GET", req: { url: `http://localhost/api/_vitehub/console/usage?agent=${record.agentName}` } })
    let release: (() => void) | undefined
    const ready = new Promise<void>(resolve => { release = resolve })
    const query = index.query.bind(index)
    const spy = vi.spyOn(index, "query")
    let capture: (() => void) | undefined
    const captured = new Promise<void>(resolve => { capture = resolve })
    spy.mockImplementationOnce(async options => {
      const result = await query(options)
      capture?.()
      await ready
      return result
    })
    const older = request()
    try {
      await captured
      if (change === "delete") {
        await db.delete(schema.invocations).where(eq(schema.invocations.id, record.id)).run()
      } else {
        const updated = { ...record, observations: [observation(9)] }
        await db.update(schema.invocations).set({ record: updated, updatedAt: new Date().toISOString() }).where(eq(schema.invocations.id, record.id)).run()
      }
      const newer = await request()
      expect(newer).toMatchObject({ totals: { invocations: change === "delete" ? 0 : 1, totalTokens: change === "delete" ? 0 : 9 } })
      release?.()
      expect(await older).toMatchObject({ totals: { invocations: 1, totalTokens: 5 } })
      expect(await request()).toEqual(newer)
      expect(spy).toHaveBeenCalledTimes(2)
    } finally {
      release?.()
      await older
      spy.mockRestore()
      await db.delete(schema.invocations).where(eq(schema.invocations.id, record.id)).run()
    }
  })

  it("reports a missing D1 binding", async () => {
    const invocations = createConsoleD1Invocations({ binding: "JOURNAL", env: () => ({}) })
    await expect(invocations.list()).rejects.toThrow("requires the D1 binding \"JOURNAL\"")
  })

  it("accepts null results for batch writes and keeps mixed read and returning results", async () => {
    const binding: AgentInvocationD1Database = {
      prepare: query => database.prepare(query),
      // doctor-disable-next-line typescript/evidence/no-caller-chosen-result-type -- Implements the D1 batch contract while reproducing an empty write response.
      async batch<T>(statements: AgentInvocationD1Statement[]) {
        const results = await database.batch<T>(statements)
        for (const result of results) {
          if (result.results.length === 0) Object.defineProperty(result, "results", { value: null })
        }
        return results
      },
    }
    installConsoleInvocations("/console-d1-null-results", undefined, undefined, undefined, {
      binding: "JOURNAL",
      env: () => ({ JOURNAL: binding }),
    })
    const journalDatabase = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    if (journalDatabase.driver !== "d1") throw new Error("Expected the D1 Console database.")
    const { db, schema } = journalDatabase
    const record = { id: "null-batch-results", traceId: "null-batch-trace", status: "completed" as const, createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-09-30T00:00:00.000Z", observations: [] }
    const values = { id: record.id, status: record.status, search: "", summary: record, record }
    const results = await db.batch([
      db.insert(schema.invocations).values(values),
      db.update(schema.invocations).set({ agentName: "batch-write" }).where(eq(schema.invocations.id, record.id)),
      db.select().from(schema.invocations).where(eq(schema.invocations.id, record.id)),
      db.delete(schema.invocations).where(eq(schema.invocations.id, record.id)),
      db.insert(schema.invocations).values(values).returning({ id: schema.invocations.id }),
    ])
    expect(results).toMatchObject([{ rows: [] }, { rows: [] }, [{ agentName: "batch-write" }], { rows: [] }, [{ id: record.id }]])
    await expect(db.select().from(schema.invocations).where(eq(schema.invocations.id, record.id))).resolves.toMatchObject([{ id: record.id }])
  })

  it("rejects callback transactions before resolving D1 or running the callback", async () => {
    const env = vi.fn(() => ({ JOURNAL: database }))
    installConsoleInvocations("/console-d1-transaction", undefined, undefined, undefined, { binding: "JOURNAL", env })
    const journalDatabase = consoleRuntime.resolve({ memo: vi.fn(), runtime: "unknown", waitUntil: vi.fn() }).invocations
    if (journalDatabase.driver !== "d1") throw new Error("Expected the D1 Console database.")
    const { db, schema } = journalDatabase
    const callback = vi.fn(async (transaction: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      await transaction.update(schema.invocations).set({ agentName: "uncommitted" })
      throw new Error("Roll back the write.")
    })
    await expect(db.transaction(callback)).rejects.toThrow("does not support db.transaction(). Use db.batch()")
    expect(callback).not.toHaveBeenCalled()
    expect(env).not.toHaveBeenCalled()
  })
})
