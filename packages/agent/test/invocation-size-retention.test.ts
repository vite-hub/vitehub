import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { hasRuntimeType } from "../src/internal/runtime-type.ts"
import { defineAgentInvocations } from "../src/invocations.ts"
import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

import type { Client, InStatement } from "@libsql/client"
import type { AgentInvocationStore, AgentInvocationStoreCreateInput } from "../src/invocations.ts"

const volume = vi.hoisted(() => ({
  original: undefined as undefined | ((path: string) => Promise<{ blocks: number, bsize: number }>),
  statfs: vi.fn<(path: string) => Promise<{ blocks: number, bsize: number }>>(),
}))
const statfs = volume.statfs
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  volume.original = async path => await original.statfs(path)
  return { ...original, statfs: volume.statfs }
})

const timestamp = Date.parse("2026-10-05T00:00:00.000Z")
const at = (index: number) => new Date(timestamp + index * 1000).toISOString()
const invocation = (id: string, index: number, status: AgentInvocationStoreCreateInput["status"] = "completed", bytes = 20_000): AgentInvocationStoreCreateInput => ({
  agentName: "review",
  createdAt: at(index),
  id,
  observations: [{
    attributes: { "message.content": `${id} ${"x".repeat(bytes)}` },
    name: "agent.message",
    sequence: 1,
    timestamp: at(index),
    type: "run",
  }],
  status,
  traceId: `${id}-trace`,
  updatedAt: at(index),
})
const terminalIds = Array.from({ length: 30 }, (_, index) => `done-${String(index).padStart(2, "0")}`)

let directory: string
let path: string
let url: string
const clients: Client[] = []

beforeEach(async () => {
  statfs.mockReset()
  statfs.mockImplementation(async path => await volume.original!(path))
  directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-size-retention-"))
  path = join(directory, "journal.sqlite")
  url = `file:${path}`
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  vi.restoreAllMocks()
  await rm(directory, { force: true, recursive: true })
})

function client(): Client {
  const created = createClient({ url })
  clients.push(created)
  return created
}

async function liveBytes(): Promise<number> {
  const result = await client().execute("SELECT (page_count - freelist_count) * page_size AS bytes FROM pragma_page_count(), pragma_freelist_count(), pragma_page_size()")
  return Number(result.rows[0]!.bytes)
}

async function seed(): Promise<void> {
  const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false })
  await store.create(invocation("active-running", 0, "running"))
  await store.create(invocation("active-pending", 1, "pending"))
  for (const [index, id] of terminalIds.entries()) await store.create(invocation(id, index + 2))
}

/** Waits for writes that the store queued, including background size retention. */
async function settled(store: AgentInvocationStore): Promise<void> {
  await store.release("missing", "missing")
}

function sqlText(statement: InStatement): string {
  return hasRuntimeType(statement, "string") ? statement : statement.sql
}

describe("SQLite Agent Invocation size retention", () => {
  it("deletes the oldest terminal records first and keeps pending and running records", async () => {
    await seed()
    const before = await liveBytes()
    const budget = before - 10 * 20_000
    const invocations = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: budget }) })

    const result = await invocations.prune()

    expect(result.ids.length).toBeGreaterThanOrEqual(10)
    expect(result.ids.length).toBeLessThan(terminalIds.length)
    expect([...result.ids].sort()).toEqual(terminalIds.slice(0, result.ids.length))
    expect(result.size).toEqual({ beforeBytes: before, afterBytes: await liveBytes(), budgetBytes: budget })
    expect(result.size!.afterBytes).toBeLessThanOrEqual(budget)
    const remaining = (await invocations.list({ limit: 100 })).invocations.map(record => record.id)
    expect(remaining).toEqual(expect.arrayContaining(["active-running", "active-pending"]))
    expect(remaining).toHaveLength(32 - result.ids.length)
  })

  it("keeps pending and running records when they alone exceed the budget", async () => {
    await seed()
    const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: 1 })
    const result = await store.prune!({})
    expect([...result.ids].sort()).toEqual(terminalIds)
    expect(result.size!.afterBytes).toBeGreaterThan(1)
    expect((await store.list({ limit: 100 })).invocations.map(record => record.id).sort()).toEqual(["active-pending", "active-running"])
  })

  it("reports the same deletes in a dry run without changing the journal", async () => {
    await seed()
    const before = await liveBytes()
    const budget = before - 8 * 20_000
    const invocations = defineAgentInvocations({ store: createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: budget }) })

    const preview = await invocations.prune({ dryRun: true })
    expect(preview.dryRun).toBe(true)
    expect(preview.ids.length).toBeGreaterThan(0)
    expect(await liveBytes()).toBe(before)
    expect((await invocations.list({ limit: 100 })).invocations).toHaveLength(32)

    const pruned = await invocations.prune()
    expect(pruned.ids).toEqual(preview.ids)
    expect(pruned.size).toEqual(preview.size)
  })

  it("applies every set limit together", async () => {
    await seed()
    const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: "1000w", maxRecords: 25, maxSize: "1TB" })
    const result = await store.prune!({})
    expect([...result.ids].sort()).toEqual(terminalIds.slice(0, 5))
    expect(result.size!.budgetBytes).toBe(1024 ** 4)
  })

  it("resolves a percent against the volume that holds the database file", async () => {
    await seed()
    const before = await liveBytes()
    const budget = before - 5 * 20_000
    statfs.mockImplementation(async () => ({ blocks: budget * 2, bsize: 1 }))
    const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: "50%" })

    const result = await store.prune!({ dryRun: true })

    expect(statfs).toHaveBeenCalledWith(directory)
    expect(result.size).toMatchObject({ beforeBytes: before, budgetBytes: budget })
    expect(result.size!.afterBytes).toBeLessThanOrEqual(budget)
  })

  it("rejects maxSize for in-memory and remote databases", async () => {
    const memory = createLibsqlAgentInvocationStore({ url: ":memory:", maxSize: "10%" })
    await expect(memory.list()).rejects.toThrow("SQLite Agent Invocation maxSize needs a database file. In-memory databases do not support it.")
    expect(() => createLibsqlAgentInvocationStore({ url: "http://127.0.0.1:9", maxSize: "500MB" }))
      .toThrow("SQLite Agent Invocation maxSize needs a local SQLite file. Remote libSQL databases do not support it.")
    expect(() => createLibsqlAgentInvocationStore({ url: "http://127.0.0.1:9", maxAge: "30d" })).not.toThrow()
  })

  it("creates new files with incremental auto vacuum and shrinks them after a prune", async () => {
    const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: "1TB" })
    for (const [index, id] of terminalIds.entries()) await store.create(invocation(id, index))
    const reader = client()
    expect((await reader.execute("PRAGMA auto_vacuum")).rows[0]!.auto_vacuum).toBe(2)
    await reader.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    const fileBefore = (await stat(path)).size

    const pruned = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: 64 * 1024 })
    const result = await pruned.prune!({})
    expect(result.ids.length).toBeGreaterThan(20)
    await reader.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    expect((await reader.execute("PRAGMA freelist_count")).rows[0]!.freelist_count).toBe(0)
    expect((await stat(path)).size).toBeLessThan(fileBefore / 2)
  })

  it("keeps the auto vacuum mode of an existing file", async () => {
    await client().execute("CREATE TABLE unrelated (value TEXT)")
    const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false })
    await store.create(invocation("one", 0))
    expect((await client().execute("PRAGMA auto_vacuum")).rows[0]!.auto_vacuum).toBe(0)
  })

  it("checks the size after writes on a cadence, not after every write", async () => {
    let measurements = 0
    const base = client()
    // SAFETY: The proxy forwards every Client member and only counts size measurements.
    const counting = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== "execute") return hasRuntimeType(value, "function") ? value.bind(target) : value
        return async (statement: InStatement) => {
          if (sqlText(statement).includes("pragma_page_count")) measurements += 1
          return await target.execute(statement)
        }
      },
    })
    const store = createLibsqlAgentInvocationStore({ client: counting, maxAge: false, maxRecords: false, maxSize: "1MB" })

    for (let index = 0; index < 20; index += 1) await store.create(invocation(`small-${index}`, index, "completed", 100))
    await settled(store)
    expect(measurements).toBe(1)

    await store.create(invocation("large", 30, "completed", 70 * 1024))
    await settled(store)
    expect(measurements).toBe(2)
  })

  it("prunes in the background after writes and never fails the write", async () => {
    const budget = 400 * 1024
    const store = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: budget })
    for (let index = 0; index < 60; index += 1) await store.create(invocation(`write-${String(index).padStart(2, "0")}`, index))
    await settled(store)
    expect(await liveBytes()).toBeLessThanOrEqual(budget + 128 * 1024)
    const ids = (await store.list({ limit: 100 })).invocations.map(record => record.id)
    expect(ids).toContain("write-59")
    expect(ids).not.toContain("write-00")

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    statfs.mockRejectedValue(new Error("statfs failed"))
    const failing = createLibsqlAgentInvocationStore({ client: client(), maxAge: false, maxRecords: false, maxSize: "10%" })
    await expect(failing.create(invocation("after-failure", 61))).resolves.toMatchObject({ created: true })
    await settled(failing)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("size retention failed"))
  })
})
