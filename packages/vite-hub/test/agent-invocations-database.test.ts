import { beforeEach, describe, expect, it, vi } from "vitest"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"

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
    const dialect = new SQLiteAsyncDialect()
    const queries: string[] = []
    const db = {
      all: vi.fn(async (query) => {
        const text = dialect.sqlToQuery(query).sql
        queries.push(text)
        if (/^INSERT\b/i.test(text)) return [{ vitehub_changed: 1 }]
        if (/^SELECT sequence, record, revision/i.test(text)) return [{ sequence: 1, record: JSON.stringify(input), revision: 0 }]
        return []
      }),
    }
    useDatabase.mockReturnValue({ db })

    const { createDatabaseAgentInvocationStore } = await import("../src/agent/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ database: "journal", maxAgeMs: false, maxRecords: false })

    await expect(store.create(input)).resolves.toMatchObject({ created: true, record: { id: input.id, cursor: "1" } })
    expect(useDatabase).toHaveBeenCalledWith("journal")
    expect(queries).toHaveLength(6)
    expect(queries.slice(0, 4).every(query => /^CREATE (?:TABLE|INDEX)/i.test(query))).toBe(true)
  })

  it("persists records through the async SQLite Drizzle adapter", async () => {
    const { createClient } = await import("@libsql/client")
    const { drizzle } = await import("drizzle-orm/libsql")
    const client = createClient({ url: "file::memory:" })
    const db = drizzle(client)
    useDatabase.mockReturnValue({ db })

    const { createDatabaseAgentInvocationStore } = await import("../src/agent/invocations/database.ts")
    const store = createDatabaseAgentInvocationStore({ maxAgeMs: false, maxRecords: false })

    await expect(store.create(input)).resolves.toMatchObject({ created: true, record: { id: input.id, cursor: "1" } })
    await expect(store.get(input.id)).resolves.toMatchObject({ id: input.id, status: input.status, cursor: "1" })
    client.close()
  })
})
