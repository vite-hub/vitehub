import { createClient } from "@libsql/client"
import type { InStatement } from "@libsql/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"
import type { AgentInvocationStoreCreateInput } from "../src/invocations.ts"

const timestamp = "2026-09-05T00:00:00.000Z"
const invocation = (id: string, input: Partial<AgentInvocationStoreCreateInput> = {}): AgentInvocationStoreCreateInput => ({
  agentName: "review",
  createdAt: timestamp,
  id,
  observations: [],
  status: "running",
  traceId: id,
  updatedAt: timestamp,
  ...input,
})
const observation = (capabilityId: string, sequence = 1) => ({
  attributes: { "capability.id": capabilityId },
  name: "agent.tool.call",
  sequence,
  timestamp,
  type: "run" as const,
})

describe("SQLite invocation Capability projection", () => {
  let client: ReturnType<typeof createClient>
  beforeEach(() => { client = createClient({ url: "file::memory:" }) })
  afterEach(() => { vi.restoreAllMocks(); client.close() })
  const store = () => createLibsqlAgentInvocationStore({ client, maxAgeMs: false, maxRecords: false })
  const projection = async (id: string) => (await client.execute({
    args: [id],
    sql: "SELECT capability_ids FROM vitehub_agent_invocations WHERE id = ?",
  })).rows[0]?.capability_ids

  it("caches complete IDs beyond the summary cap without rewriting cached rows", async () => {
    const journal = store()
    const ids = Array.from({ length: 256 }, (_, index) => `capability-${index}`)
    await journal.create(invocation("complete", {
      capabilityIds: ids,
      observations: [observation(" observation-only "), observation(" ", 2)],
    }))
    expect(await projection("complete")).toBeNull()
    const expected = [...ids, "observation-only"].sort()
    expect(await journal.listCapabilityIds!()).toEqual(expected)
    expect(JSON.parse(String(await projection("complete"))).sort()).toEqual(expected)
    const changes = (await client.execute("SELECT total_changes() AS count")).rows[0]?.count
    expect(await journal.listCapabilityIds!()).toEqual(expected)
    expect((await client.execute("SELECT total_changes() AS count")).rows[0]?.count).toBe(changes)
    expect((await journal.getSummary("complete"))?.capabilityIds).toEqual(ids)
  })

  it("scopes cache population and invalidates on record updates", async () => {
    const journal = store()
    await journal.create(invocation("review", { observations: [observation("first")] }))
    await journal.create(invocation("other", { agentName: "other", capabilityIds: ["other"] }))
    expect(await journal.listCapabilityIds!(" review ")).toEqual(["first"])
    expect(await projection("other")).toBeNull()
    await journal.update("review", { observation: observation("second", 2), timestamp })
    expect(await projection("review")).toBeNull()
    expect(await journal.listCapabilityIds!("review")).toEqual(["first", "second"])
    expect(await journal.listCapabilityIds!()).toEqual(["first", "other", "second"])
  })

  it("migrates legacy rows and invalidates cached IDs for older writers", async () => {
    await client.execute(`CREATE TABLE vitehub_agent_invocations (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, record TEXT NOT NULL
    )`)
    const legacy = invocation("legacy", { observations: [observation("legacy-only")] })
    await client.execute({ args: [legacy.id, legacy.status, JSON.stringify(legacy)], sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES (?, ?, ?)" })
    const journal = store()
    expect(await journal.listCapabilityIds!("review")).toEqual(["legacy-only"])
    await client.execute({
      args: [JSON.stringify({ ...legacy, observations: [observation("replacement")] })],
      sql: "UPDATE vitehub_agent_invocations SET record = ? WHERE id = 'legacy'",
    })
    expect(await projection("legacy")).toBeNull()
    expect(await journal.listCapabilityIds!("review")).toEqual(["replacement"])
    await client.execute("DELETE FROM vitehub_agent_invocations WHERE id = 'legacy'")
    expect(await journal.listCapabilityIds!()).toEqual([])
  })

  it("reads current IDs when another writer changes a row after cache population", async () => {
    const journal = store()
    const record = invocation("concurrent", { observations: [observation("before")] })
    await journal.create(record)
    const execute = client.execute.bind(client)
    let changed = false
    vi.spyOn(client, "execute").mockImplementation(async (statement: InStatement) => {
      const result = await execute(statement)
      const sql = typeof statement === "string" ? statement : statement.sql
      if (!changed && sql.includes("SET capability_ids = (SELECT")) {
        changed = true
        await execute({
          args: [JSON.stringify({ ...record, observations: [observation("after")] })],
          sql: "UPDATE vitehub_agent_invocations SET record = ? WHERE id = 'concurrent'",
        })
      }
      return result
    })
    expect(await journal.listCapabilityIds!()).toEqual(["after"])
    expect(changed).toBe(true)
    expect(await projection("concurrent")).toBeNull()
    expect(await journal.listCapabilityIds!()).toEqual(["after"])
  })
})
