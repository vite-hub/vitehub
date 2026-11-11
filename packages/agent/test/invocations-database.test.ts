import { beforeEach, describe, expect, it, vi } from "vitest"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"
import { Miniflare } from "miniflare"

const useDatabase = vi.fn()
vi.mock("@vite-hub/database/drizzle", () => ({ useDatabase }))

import type { AgentInvocationStoreCreateInput } from "@vite-hub/agent/server"

const input: AgentInvocationStoreCreateInput = {
  agentName: "reviewer",
  completedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  id: "invocation-1",
  observations: [],
  status: "completed",
  traceId: "trace-1",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("createDatabaseAgentInvocationStore", () => {
  beforeEach(() => {
    vi.resetModules()
    useDatabase.mockReset()
  })

  it("creates the journal schema once and adapts named database rows", async () => {
    const dialect = new SQLiteDialect()
    const queries: string[] = []
    const db = {
      all: vi.fn(async (query) => {
        const text = dialect.sqlToQuery(query).sql
        queries.push(text)
        if (/^INSERT\b/i.test(text)) return [{ vitehub_changed: 1 }]
        if (/^SELECT sequence, record, revision/i.test(text)) return [{ sequence: 1, record: JSON.stringify(input), revision: 0 }]
        return []
      }),
      batch: vi.fn(async (statements: Promise<unknown>[]) => Promise.all(statements)),
    }
    useDatabase.mockReturnValue({ db })

    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ database: "journal", maxAge: false, maxRecords: false })

    await expect(store.create(input)).resolves.toMatchObject({ created: true, record: { id: input.id, cursor: "1" } })
    expect(useDatabase).toHaveBeenCalledWith("journal")
    expect(queries).toHaveLength(7)
    expect(queries[0]).toBe("SELECT 1 AS vitehub_probe")
    expect(queries.slice(1, 5).every(query => /^CREATE (?:TABLE|INDEX)/i.test(query))).toBe(true)
  })

  it("rejects a proxy driver that returns row matrices for named rows, before schema creation or writes", async () => {
    const { drizzle } = await import("drizzle-orm/sqlite-proxy")
    const all = vi.fn(async () => [[1]])
    const batch = vi.fn(async (queries: unknown[]) => queries.map(() => [[1]]))
    useDatabase.mockReturnValue({ db: drizzle({ all, batch, get: async () => [1], run: async () => ({}) }) })
    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })

    await expect(store.create(input)).rejects.toThrow("Cloudflare D1 HTTP driver is not supported")
    expect(all).not.toHaveBeenCalled()
    expect(batch).toHaveBeenCalledExactlyOnceWith([
      { method: "all", params: [], rowMode: "object", sql: "SELECT 1 AS vitehub_probe" },
    ])
  })

  it("persists records through the async SQLite Drizzle adapter", async () => {
    const { createClient } = await import("@libsql/client")
    const { drizzle } = await import("drizzle-orm/libsql")
    const client = createClient({ url: "file::memory:" })
    const db = drizzle({ client: client })
    useDatabase.mockReturnValue({ db })

    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })

    await expect(store.create(input)).resolves.toMatchObject({ created: true, record: { id: input.id, cursor: "1" } })
    await expect(store.get(input.id)).resolves.toMatchObject({ id: input.id, status: input.status, cursor: "1" })
    client.close()
  })

  it("reads observations after a sequence through the SQLite Drizzle adapter", async () => {
    const { createClient } = await import("@libsql/client")
    const { drizzle } = await import("drizzle-orm/libsql")
    const client = createClient({ url: "file::memory:" })
    useDatabase.mockReturnValue({ db: drizzle({ client }) })

    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })
    const observations = ["agent.tool.call", "agent.invocation.finish", "agent.invocation.finish"]
      .map((name, index) => ({ name, sequence: index + 1, timestamp: input.createdAt, type: "run" as const }))
    await store.create({ ...input, observations })

    const sequences = async (options: { afterSequence: number, observationNames?: string[] }) =>
      (await store.get(input.id, options))?.observations.map(observation => observation.sequence)
    await expect(sequences({ afterSequence: 1 })).resolves.toEqual([2, 3])
    await expect(sequences({ afterSequence: 2, observationNames: ["agent.invocation.finish"] })).resolves.toEqual([3])
    client.close()
  })

  it("reinitializes when a runtime proxy switches its database client", async () => {
    const dialect = new SQLiteDialect()
    const createDatabase = (client: object) => {
      const queries: string[] = []
      const db = {
        $client: client,
        all: vi.fn(async (query) => {
          const text = dialect.sqlToQuery(query).sql
          queries.push(text)
          if (/^INSERT\b/i.test(text)) return [{ vitehub_changed: 1 }]
          if (/^SELECT sequence, record, revision/i.test(text)) return [{ sequence: 1, record: JSON.stringify(input), revision: 0 }]
          return []
        }),
        batch: vi.fn(async (statements: Promise<unknown>[]) => Promise.all(statements)),
        queries,
      }
      return db
    }
    const clients = [{}, {}]
    const databases = [createDatabase(clients[0]), createDatabase(clients[1])]
    let active = 0
    const runtime = {
      get $client() { return databases[active].$client },
      all: (query: unknown) => databases[active].all(query),
      batch: (statements: Promise<unknown>[]) => databases[active].batch(statements),
    }
    useDatabase.mockReturnValue({ db: runtime })

    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })
    await expect(store.create(input)).resolves.toMatchObject({ created: true })
    active = 1
    await expect(store.create({ ...input, id: "invocation-2" })).resolves.toMatchObject({ created: true })
    expect(databases[0].queries.filter(query => /^CREATE TABLE/i.test(query))).toHaveLength(1)
    expect(databases[1].queries.filter(query => /^CREATE TABLE/i.test(query))).toHaveLength(1)
  })

  it("persists records through the native D1 Drizzle adapter", async () => {
    const miniflare = new Miniflare({
      compatibilityDate: "2026-07-14",
      d1Databases: ["DB"],
      modules: true,
      script: "export default { fetch() { return new Response('test') } }",
    })
    try {
      const d1 = await miniflare.getD1Database("DB")
      const { drizzle } = await import("drizzle-orm/d1")
      const drizzleDb = drizzle(d1)
      useDatabase.mockReturnValue({ db: drizzleDb })

      const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
      const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })

      await expect(store.create(input)).resolves.toMatchObject({ created: true, record: { id: input.id, cursor: "1" } })
      await expect(store.get(input.id)).resolves.toMatchObject({ id: input.id, status: input.status, cursor: "1" })
    }
    finally {
      await miniflare.dispose()
    }
  })

  it("counts direct D1 batches in the request's database stats", async () => {
    const batch = vi.fn(async () => [{ results: [{ vitehub_probe: 1 }] }])
    const d1 = { batch, prepare: () => ({ bind: () => ({}) }) }
    useDatabase.mockReturnValue({ db: { $client: d1, all: vi.fn(async () => []), batch: vi.fn() } })
    const { createDatabaseAgentInvocationStore } = await import("../src/invocations/database.ts")
    const { runWithDatabaseRequestStats } = await import("@vite-hub/database/runtime/request-stats")
    const set = vi.fn()
    const store = createDatabaseAgentInvocationStore({ maxAge: false, maxRecords: false })

    await runWithDatabaseRequestStats({ req: { context: { log: { set } } } }, () => store.get(input.id))

    expect(batch).toHaveBeenCalled()
    expect(set).toHaveBeenCalledWith({ database: expect.objectContaining({ calls: batch.mock.calls.length }) })
  })
})
