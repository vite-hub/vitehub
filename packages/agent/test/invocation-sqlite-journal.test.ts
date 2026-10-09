import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import type { Client, InStatement, Transaction, TransactionMode } from "@libsql/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { hasRuntimeType } from "../src/internal/runtime-type.ts"
import { createMemoryAgentInvocationStore, observationLimits } from "../src/invocations.ts"
import type { AgentInvocationRecord, AgentInvocationStore, AgentInvocationStoreCreateInput, AgentInvocationStoreUpdateInput } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

const timestamp = "2026-10-05T00:00:00.000Z"
const at = (second: number) => new Date(Date.parse(timestamp) + second * 1000).toISOString()
const invocation = (id: string, input: Partial<AgentInvocationStoreCreateInput> = {}): AgentInvocationStoreCreateInput => ({
  agentName: "review",
  createdAt: timestamp,
  id,
  observations: [],
  status: "running",
  traceId: `${id}-trace`,
  updatedAt: timestamp,
  ...input,
})
const step = (sequence: number, attributes: Record<string, unknown> = {}) => ({
  attributes: { "message.content": `step ${sequence} ${"x".repeat(2000)}`, ...attributes },
  name: "agent.message",
  sequence,
  timestamp: at(sequence),
  type: "run" as const,
})

function statementSql(statement: unknown): string {
  if (hasRuntimeType(statement, "string")) return statement
  return statement !== null && hasRuntimeType(statement, "object") && "sql" in statement && hasRuntimeType(statement.sql, "string") ? statement.sql : ""
}

/** Records the SQL and arguments that the store sends through the client and its transactions. */
function recordingClient(client: Client, protocol = client.protocol) {
  const statements: unknown[] = []
  const record = (statement: unknown) => {
    statements.push(statement)
  }
  const wrapTransaction = (transaction: Transaction) => new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (property !== "execute") return hasRuntimeType(value, "function") ? value.bind(target) : value
      return async (statement: InStatement) => {
        record(statement)
        return await target.execute(statement)
      }
    },
  })
  // SAFETY: The proxy forwards every Client member and only records statements.
  const proxy = new Proxy(client, {
    get(target, property) {
      if (property === "protocol") return protocol
      const value = Reflect.get(target, property)
      if (property === "execute") {
        return async (statement: InStatement) => {
          record(statement)
          return await target.execute(statement)
        }
      }
      if (property === "batch") {
        return async (batch: InStatement[], mode?: TransactionMode) => {
          batch.forEach(record)
          return await target.batch(batch, mode)
        }
      }
      if (property === "transaction") {
        return async (mode?: TransactionMode) => wrapTransaction(await target.transaction(mode))
      }
      return hasRuntimeType(value, "function") ? value.bind(target) : value
    },
  }) as Client
  return { client: proxy, statements }
}

function withoutCursor(record: AgentInvocationRecord | undefined) {
  if (!record) return record
  const { cursor: _cursor, ...rest } = record
  return rest
}

describe("SQLite invocation journal", () => {
  let directory: string
  let url: string
  let client: Client
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-journal-"))
    url = `file:${join(directory, "invocations.sqlite")}`
    client = createClient({ url })
  })
  afterEach(async () => {
    client.close()
    await rm(directory, { force: true, recursive: true })
  })

  it.each(["observation read", "later page"])("revisits stale search rows after a raced %s", async (race) => {
    const writer = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    await writer.create(invocation("run"))
    await writer.list({ search: "initial" })
    await writer.update("run", { observation: step(1), timestamp: at(1) })
    if (race === "later page") {
      for (let index = 0; index < 100; index++) await writer.create(invocation(`other-${index}`))
      await client.execute("UPDATE vitehub_agent_invocations SET search_version = 0")
    }
    let raced = false
    let observationReads = 0
    const readerClient = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== "execute") return hasRuntimeType(value, "function") ? value.bind(target) : value
        return async (statement: InStatement) => {
          const result = await target.execute(statement)
          const sql = statementSql(statement)
          if (sql.includes("SELECT invocation_sequence, position, observation")) observationReads++
          const atRace = observationReads === (race === "observation read" ? 1 : 2)
          if (!raced && atRace) {
            raced = true
            await writer.update("run", { observation: step(2, { "message.content": "raced-search-needle" }), timestamp: at(2) })
          }
          return result
        }
      },
    })
    const reader = createLibsqlAgentInvocationStore({ client: readerClient, maxAgeMs: false, maxRecords: false })
    const result = await reader.list({ search: "raced-search-needle" })
    expect(raced).toBe(true)
    expect(result.invocations.map(record => record.id)).toEqual(["run"])
  })

  it("backfills null search text even when its version is current", async () => {
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    await store.create(invocation("null-search"))
    await store.list({ search: "null-search" })
    await client.execute("UPDATE vitehub_agent_invocations SET search = NULL")
    expect((await store.list({ search: "null-search" })).invocations.map(record => record.id)).toEqual(["null-search"])
  })

  it("uses WAL with synchronous NORMAL for local database files", async () => {
    const recording = recordingClient(client)
    const store = createLibsqlAgentInvocationStore({ client: recording.client, maxAgeMs: false, maxRecords: false })
    await store.create(invocation("run"))
    expect((await client.execute("PRAGMA journal_mode")).rows[0]?.journal_mode).toBe("wal")
    const sql = recording.statements.map(statementSql)
    expect(sql).toContain("PRAGMA journal_mode = WAL")
    // synchronous is per connection, so every write sets it on the connection it borrows.
    recording.statements.length = 0
    await store.update("run", { observation: step(1), timestamp: at(1) })
    expect(recording.statements.map(statementSql)[0]).toBe("PRAGMA synchronous = NORMAL")
    expect((await client.execute("PRAGMA synchronous")).rows[0]?.synchronous).toBe(1)
  })

  it.each(["http", "https", "ws", "wss"])("does not set journal pragmas for remote %s databases", async (protocol) => {
    const memory = createClient({ url: ":memory:" })
    try {
      const recording = recordingClient(memory, protocol)
      const store = createLibsqlAgentInvocationStore({ client: recording.client, maxAgeMs: false, maxRecords: false })
      await store.create(invocation("run"))
      await store.update("run", { observation: step(1), timestamp: at(1) })
      expect(recording.statements.map(statementSql).filter(sql => sql.startsWith("PRAGMA journal_mode") || sql.startsWith("PRAGMA synchronous"))).toEqual([])
    }
    finally {
      memory.close()
    }
  })

  it("does not set synchronous NORMAL for in-memory databases", async () => {
    const memory = createClient({ url: ":memory:" })
    try {
      const recording = recordingClient(memory)
      const store = createLibsqlAgentInvocationStore({ client: recording.client, maxAgeMs: false, maxRecords: false })
      await store.create(invocation("run"))
      await store.update("run", { observation: step(1), timestamp: at(1) })
      expect(recording.statements.map(statementSql).filter(sql => sql.startsWith("PRAGMA synchronous"))).toEqual([])
    }
    finally {
      memory.close()
    }
  })

  it("writes a bounded amount per append to a running invocation", async () => {
    const recording = recordingClient(client)
    const store = createLibsqlAgentInvocationStore({ client: recording.client, maxAgeMs: false, maxRecords: false })
    await store.create(invocation("run"))
    const writtenPerUpdate: number[] = []
    for (let sequence = 1; sequence <= 40; sequence++) {
      recording.statements.length = 0
      await store.update("run", { observation: step(sequence), timestamp: at(sequence) })
      const writes = recording.statements.filter(statement => /^\s*(UPDATE|INSERT|DELETE)/.test(statementSql(statement)))
      // One record row update and one observation row insert. Search text is rebuilt on demand.
      expect(writes.map(statement => statementSql(statement).split(" SET ")[0]!.split(" VALUES ")[0]!.trim())).toEqual([
        "UPDATE vitehub_agent_invocations",
        "INSERT INTO vitehub_agent_invocations_observations (invocation_sequence, observation)",
      ])
      expect(statementSql(writes[0])).not.toContain("search = ?")
      writtenPerUpdate.push(writes.reduce<number>((bytes, statement) => bytes + JSON.stringify(statement).length, 0))
    }
    // The 40th append writes about as much as the first, not 40 times more.
    expect(Math.max(...writtenPerUpdate)).toBeLessThan(writtenPerUpdate[0]! * 1.5)
    const row = (await client.execute("SELECT length(record) AS size, json_array_length(record, '$.observations') AS count FROM vitehub_agent_invocations WHERE id = 'run'")).rows[0]
    expect(row?.count).toBe(0)
    expect(Number(row?.size)).toBeLessThan(2000)
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations_observations")).rows[0]?.count).toBe(40)

    const saved = await store.get("run")
    expect(saved?.observations.map(observation => observation.sequence)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
  })

  it("moves every observation into the record column on the terminal update", async () => {
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    await store.create(invocation("run", { observations: [step(1)] }))
    for (let sequence = 2; sequence <= 5; sequence++) await store.update("run", { observation: step(sequence), timestamp: at(sequence) })
    await store.update("run", { status: "completed", timestamp: at(6) })
    // Readers of the record column, such as the Console usage index, see the complete record.
    const row = (await client.execute(`SELECT status, json_array_length(record, '$.observations') AS count,
      (SELECT count(*) FROM vitehub_agent_invocations_observations) AS rows FROM vitehub_agent_invocations WHERE id = 'run'`)).rows[0]
    expect(row).toMatchObject({ count: 5, rows: 0, status: "completed" })
    expect((await store.get("run"))?.observations.map(observation => observation.sequence)).toEqual([1, 2, 3, 4, 5])
  })

  it("keeps get, observation filters, list, search, and Capability filters for running invocations", async () => {
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    await store.create(invocation("run"))
    await store.create(invocation("other", { agentName: "other" }))
    await store.update("run", { observation: step(1), timestamp: at(1) })
    await store.update("run", {
      observation: { attributes: { "capability.id": "github", "message.content": "needle in a running invocation" }, name: "agent.tool.call", sequence: 2, timestamp: at(2), type: "run" },
      timestamp: at(2),
    })

    expect((await store.get("run", { observationNames: ["agent.tool.call"] }))?.observations.map(observation => observation.sequence)).toEqual([2])
    expect((await store.list({ search: "needle in a running" })).invocations.map(entry => entry.id)).toEqual(["run"])
    expect((await store.list({ capabilityId: "github" })).invocations.map(entry => entry.id)).toEqual(["run"])
    expect(await store.listCapabilityIds!("review")).toEqual(["github"])
    expect((await store.list()).invocations.map(entry => entry.id)).toEqual(["other", "run"])
    expect((await store.getSummary("run"))?.updatedAt).toBe(at(2))
    // A later append makes the search text stale. The next search rebuilds it.
    await store.update("run", { observation: { ...step(3), attributes: { "message.content": "second needle" } }, timestamp: at(3) })
    expect((await store.list({ search: "second needle" })).invocations.map(entry => entry.id)).toEqual(["run"])
  })

  it("deletes observation rows with their invocation", async () => {
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    await store.create(invocation("run"))
    await store.update("run", { observation: step(1), timestamp: at(1) })
    await client.execute("UPDATE vitehub_agent_invocations SET status = 'failed' WHERE id = 'run'")
    expect(await store.delete!("run")).toBe("deleted")
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations_observations")).rows[0]?.count).toBe(0)
  })

  it("reads and continues records written in the previous format", async () => {
    await client.execute(`CREATE TABLE vitehub_agent_invocations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      agent_name TEXT NOT NULL DEFAULT '',
      search TEXT,
      search_version INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      capability_ids TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      record TEXT NOT NULL
    )`)
    await client.execute(`CREATE TRIGGER vitehub_agent_invocations_capability_ids_update
      AFTER UPDATE OF record ON vitehub_agent_invocations
      BEGIN
        UPDATE vitehub_agent_invocations SET capability_ids = NULL WHERE sequence = NEW.sequence;
      END`)
    const legacy = { ...invocation("legacy", { observations: [step(1), step(2)] }), updatedAt: at(2) }
    const { observations: _observations, ...summary } = legacy
    await client.execute({
      args: [legacy.id, legacy.status, "review", JSON.stringify(summary), legacy.updatedAt, JSON.stringify(legacy)],
      sql: `INSERT INTO vitehub_agent_invocations (id, status, agent_name, search, search_version, summary, updated_at, record)
        VALUES (?, ?, ?, NULL, 0, ?, ?, ?)`,
    })
    const store = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    expect(withoutCursor(await store.get("legacy"))).toEqual(legacy)
    expect((await store.list({ search: "step 2" })).invocations.map(entry => entry.id)).toEqual(["legacy"])
    // The redundant trigger is replaced by one that does not rewrite the row after each update.
    const triggers = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%capability_ids_update%'")).rows.map(row => row.name)
    expect(triggers).toEqual(["vitehub_agent_invocations_capability_ids_update_v2"])

    await store.update("legacy", { observation: step(3), timestamp: at(3) })
    // Existing observations stay in the record column. The append is a row.
    const row = (await client.execute("SELECT json_array_length(record, '$.observations') AS count FROM vitehub_agent_invocations WHERE id = 'legacy'")).rows[0]
    expect(row?.count).toBe(2)
    expect((await store.get("legacy"))?.observations.map(observation => observation.sequence)).toEqual([1, 2, 3])
    await store.update("legacy", { status: "completed", timestamp: at(4) })
    expect((await client.execute("SELECT json_array_length(record, '$.observations') AS count FROM vitehub_agent_invocations WHERE id = 'legacy'")).rows[0]?.count).toBe(3)
  })

  it("matches the memory store for appends, reordering, eviction, and terminal evidence", async () => {
    const limits = { ...observationLimits(), maxCount: 6 }
    const create = invocation("run", { observationLimits: limits, observations: [step(2)] })
    const appendIdentity = (id: string) => ({ attributes: { "vitehub.observation.id": id }, name: "report.pending", timestamp: at(30), type: "capability" as const })
    const updates: AgentInvocationStoreUpdateInput[] = [
      { observation: step(3), timestamp: at(3) },
      { appendObservation: appendIdentity("first"), timestamp: at(4) },
      // A lower sequence goes before existing observations.
      { observation: step(1), timestamp: at(5) },
      { observation: step(3), timestamp: at(6) },
      { appendObservation: appendIdentity("first"), timestamp: at(7) },
      { observation: step(7, { "capability.id": "github" }), timestamp: at(7) },
      { observation: step(8), timestamp: at(8) },
      // The count limit evicts observations once the record is full.
      { observation: step(9), timestamp: at(9) },
      { observation: step(10), timestamp: at(10) },
      { observation: { ...step(11), name: "agent.invocation.finish" }, timestamp: at(11) },
      { status: "completed", timestamp: at(12) },
      { observation: { ...step(13), name: "late.event" }, timestamp: at(13) },
      { appendObservation: appendIdentity("late"), timestamp: at(14) },
    ]
    const run = async (store: AgentInvocationStore) => {
      await store.create(structuredClone(create))
      const results: unknown[] = []
      for (const update of updates) {
        try {
          results.push(withoutCursor(await store.update("run", structuredClone(update))))
        }
        catch (error) {
          results.push(error instanceof Error ? error.message : String(error))
        }
        results.push(withoutCursor(await store.get("run")))
      }
      return results
    }
    const sqlite = createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
    expect(await run(sqlite)).toEqual(await run(createMemoryAgentInvocationStore()))
  })
})
