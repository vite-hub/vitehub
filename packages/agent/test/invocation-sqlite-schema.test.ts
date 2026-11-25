import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import type { Client, InStatement, Transaction, TransactionMode } from "@libsql/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createLibsqlAgentInvocationStore } from "../src/invocations/sqlite.ts"

const latencyMs = 50
const sqldUrl = process.env.VITEHUB_SQLD_URL

const delay = () => new Promise(resolve => setTimeout(resolve, latencyMs))

function remoteClient(client: Client) {
  const counter = { requests: 0 }
  const request = async <T>(operation: () => Promise<T>) => {
    counter.requests++
    await delay()
    return await operation()
  }
  const wrapTransaction = (transaction: Transaction) => new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property)
      if (typeof value !== "function") return value
      if (property === "close") return value.bind(target)
      return async (...args: unknown[]) => await request(async () => await Reflect.apply(value, target, args))
    },
  })
  const proxy = new Proxy(client, {
    get(target, property) {
      if (property === "protocol") return "http"
      const value = Reflect.get(target, property)
      if (property === "execute") return async (statement: InStatement) => await request(async () => await target.execute(statement))
      if (property === "batch") return async (statements: InStatement[], mode?: TransactionMode) => await request(async () => await target.batch(statements, mode))
      if (property === "executeMultiple") return async (sql: string) => await request(async () => await target.executeMultiple(sql))
      if (property === "transaction") return async (mode?: TransactionMode) => wrapTransaction(await request(async () => await target.transaction(mode)))
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { client: proxy, counter }
}

const freshRequests = 6

async function measureOpen(client: Client, counter: { requests: number }, tablePrefix?: string) {
  counter.requests = 0
  const started = performance.now()
  await createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false, tablePrefix }).open()
  return { ms: Math.round(performance.now() - started), requests: counter.requests }
}

describe("SQLite Agent Invocation schema setup on a remote database", () => {
  const clients: Client[] = []
  afterEach(() => {
    for (const client of clients.splice(0)) client.close()
  })

  it(`sends few requests at ${latencyMs} ms latency per request`, async () => {
    const memory = createClient({ url: ":memory:" })
    clients.push(memory)
    const remote = remoteClient(memory)
    const fresh = await measureOpen(remote.client, remote.counter)
    const current = await measureOpen(remote.client, remote.counter)
    console.info(`[schema-requests] fresh: ${fresh.requests} requests, ${fresh.ms} ms; current: ${current.requests} requests, ${current.ms} ms`)
    expect(fresh.requests).toBe(freshRequests)
    expect(current.requests).toBe(1)
  })

  it.skipIf(!sqldUrl)("sends few requests to sqld", async () => {
    const sqld = createClient({ url: sqldUrl! })
    clients.push(sqld)
    const tablePrefix = `schema_test_${randomUUID().replaceAll("-", "")}_`
    const remote = remoteClient(sqld)
    try {
      const fresh = await measureOpen(remote.client, remote.counter, tablePrefix)
      const current = await measureOpen(remote.client, remote.counter, tablePrefix)
      console.info(`[schema-requests] sqld fresh: ${fresh.requests} requests, ${fresh.ms} ms; current: ${current.requests} requests, ${current.ms} ms`)
      expect(fresh.requests).toBe(freshRequests)
      expect(current.requests).toBe(1)
    }
    finally {
      await sqld.batch(["invocations_observations", "invocations_claims", "invocations_schema", "invocations"].map(name => `DROP TABLE IF EXISTS ${tablePrefix}${name}`), "write")
    }
  })
})

const timestamp = "2026-10-05T00:00:00.000Z"
const record = (id: string, agentName = "review") => JSON.stringify({
  agentName, createdAt: timestamp, id, observations: [], status: "completed", traceId: `${id}-trace`, updatedAt: timestamp,
})
const columnNames = async (client: Client, table: string) => (await client.execute(`PRAGMA table_info(${table})`)).rows.map(row => row.name)
const fingerprint = async (client: Client) => (await client.execute("SELECT fingerprint FROM vitehub_agent_invocations_schema")).rows[0]?.fingerprint
const triggerNames = async (client: Client) => (await client.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")).rows.map(row => row.name)

async function createFirstReleaseJournal(client: Client) {
  await client.executeMultiple(`
    CREATE TABLE vitehub_agent_invocations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE vitehub_agent_invocations_claims (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `)
  for (let index = 0; index < 150; index++) {
    await client.execute({ args: [`old-${index}`, "running", record(`old-${index}`, `agent-${index % 3}`)], sql: "INSERT INTO vitehub_agent_invocations (id, status, record) VALUES (?, ?, ?)" })
  }
  await client.execute("INSERT INTO vitehub_agent_invocations_claims (id, claim_id, expires_at) VALUES ('old-0', 'worker', 0)")
}

describe("SQLite Agent Invocation schema migrations", () => {
  let directory: string
  let url: string
  let client: Client
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "vitehub-invocation-schema-"))
    url = `file:${join(directory, "invocations.sqlite")}`
    client = createClient({ url })
  })
  afterEach(async () => {
    client.close()
    await rm(directory, { force: true, recursive: true })
  })

  it.each([false, true])("opens an unmarked read-only journal only if its schema is current (missing index: %s)", async (missingIndex) => {
    const writer = createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false })
    await writer.create({
      agentName: "review", createdAt: timestamp, id: "legacy", observations: [], status: "completed", traceId: "trace", updatedAt: timestamp,
    })
    await client.execute("DROP TABLE vitehub_agent_invocations_schema")
    if (missingIndex) await client.execute("DROP INDEX vitehub_agent_invocations_status_sequence")
    await client.execute("PRAGMA query_only = ON")

    const reader = createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false })
    if (missingIndex) {
      await expect(reader.open()).rejects.toMatchObject({ code: "SQLITE_READONLY" })
    }
    else {
      expect(await reader.get("legacy")).toMatchObject({ id: "legacy" })
      expect((await reader.list()).invocations.map(invocation => invocation.id)).toEqual(["legacy"])
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'vitehub_agent_invocations_schema'")).rows).toEqual([])
    }
  })

  it("migrates every column and backfill of a first-release journal", async () => {
    await createFirstReleaseJournal(client)
    await client.execute(`CREATE TRIGGER vitehub_agent_invocations_capability_ids_update AFTER UPDATE OF record ON vitehub_agent_invocations
      BEGIN SELECT 1; END`)
    const store = createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false })
    await store.open()
    expect(await columnNames(client, "vitehub_agent_invocations")).toEqual(expect.arrayContaining(["search", "agent_name", "search_version", "summary", "capability_ids", "updated_at"]))
    expect(await columnNames(client, "vitehub_agent_invocations_claims")).toEqual(expect.arrayContaining(["claimed_at", "claim_token"]))
    const rows = (await client.execute("SELECT agent_name, updated_at FROM vitehub_agent_invocations WHERE agent_name IS NULL OR updated_at = '' OR updated_at IS NULL")).rows
    expect(rows).toEqual([])
    expect((await client.execute("SELECT agent_name FROM vitehub_agent_invocations WHERE id = 'old-149'")).rows[0]?.agent_name).toBe("agent-2")
    expect((await client.execute("SELECT claimed_at FROM vitehub_agent_invocations_claims")).rows[0]?.claimed_at).not.toBe(0)
    expect(await triggerNames(client)).not.toContain("vitehub_agent_invocations_capability_ids_update")
    expect(await fingerprint(client)).toMatch(/^[0-9a-f]{64}$/)
    expect((await store.list({ agentName: "agent-1" })).invocations).toHaveLength(50)
  })

  it("runs every phase again after a start that stopped before the fingerprint", async () => {
    await createFirstReleaseJournal(client)
    let failed = false
    const interrupted = new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== "executeMultiple") return typeof value === "function" ? value.bind(target) : value
        return async (sql: string) => {
          if (!failed && sql.includes("_schema (id, fingerprint)")) {
            failed = true
            return await target.executeMultiple(sql.replace("COMMIT;", "SELECT * FROM missing_table;\nCOMMIT;"))
          }
          return await target.executeMultiple(sql)
        }
      },
    })
    await expect(createLibsqlAgentInvocationStore({ client: interrupted, maxAge: false, maxRecords: false }).open()).rejects.toThrow(/missing_table/)
    expect(await fingerprint(client)).toBeUndefined()
    expect((await client.execute("SELECT name FROM sqlite_master WHERE name = 'vitehub_agent_invocations_status_sequence'")).rows).toEqual([])

    const store = createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false })
    await store.open()
    expect(await fingerprint(client)).toMatch(/^[0-9a-f]{64}$/)
    expect((await store.list({ agentName: "agent-0", limit: 100 })).invocations).toHaveLength(50)
  })

  it.each([false, true])("lets two cold starts share one file (first release: %s)", async (firstRelease) => {
    if (firstRelease) await createFirstReleaseJournal(client)
    for (let attempt = 0; attempt < 5; attempt++) {
      await client.execute("DROP TABLE IF EXISTS vitehub_agent_invocations_schema")
      const clients = [createClient({ url }), createClient({ url })]
      try {
        const stores = clients.map(client => createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false }))
        await Promise.all(stores.map(async store => await store.open()))
        await Promise.all(stores.map(async (store, index) => await store.create({
          agentName: "review", createdAt: timestamp, id: `new-${attempt}-${index}`, observations: [], status: "running", traceId: "trace", updatedAt: timestamp,
        })))
      }
      finally {
        for (const client of clients) client.close()
      }
    }
    expect(await fingerprint(client)).toMatch(/^[0-9a-f]{64}$/)
    expect((await client.execute("SELECT count(*) AS count FROM vitehub_agent_invocations WHERE id LIKE 'new-%'")).rows[0]?.count).toBe(10)
  })

  it("retries the column phase when another cold start added the columns after its inspection", async () => {
    await createFirstReleaseJournal(client)
    let waiting = 0
    let release = () => {}
    const bothInspected = new Promise<void>((resolve) => {
      release = resolve
    })
    const clients = [createClient({ url }), createClient({ url })]
    const stores = clients.map(client => createLibsqlAgentInvocationStore({ client: new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property !== "executeMultiple") return typeof value === "function" ? value.bind(target) : value
        return async (sql: string) => {
          if (sql.includes("ADD COLUMN") && waiting < 2) {
            if (++waiting === 2) release()
            await bothInspected
          }
          return await target.executeMultiple(sql)
        }
      },
    }), maxAge: false, maxRecords: false }))
    try {
      await Promise.all(stores.map(async store => await store.open()))
    }
    finally {
      for (const client of clients) client.close()
    }
    expect(waiting).toBe(2)
    expect(await columnNames(client, "vitehub_agent_invocations")).toEqual(expect.arrayContaining(["agent_name", "updated_at"]))
    expect(await fingerprint(client)).toMatch(/^[0-9a-f]{64}$/)
  })

  it("migrates again when an older version recreates a dropped trigger or the schema changes", async () => {
    await createLibsqlAgentInvocationStore({ client, maxAge: false, maxRecords: false }).open()
    const recording = remoteClient(client)
    const open = async () => {
      recording.counter.requests = 0
      await createLibsqlAgentInvocationStore({ client: recording.client, maxAge: false, maxRecords: false }).open()
      return recording.counter.requests
    }
    expect(await open()).toBe(1)
    await client.execute(`CREATE TRIGGER vitehub_agent_invocations_legacy_updated_at_update AFTER UPDATE OF record ON vitehub_agent_invocations
      BEGIN SELECT 1; END`)
    expect(await open()).toBeGreaterThan(1)
    expect(await triggerNames(client)).not.toContain("vitehub_agent_invocations_legacy_updated_at_update")
    expect(await open()).toBe(1)
    await client.execute("UPDATE vitehub_agent_invocations_schema SET fingerprint = 'older'")
    expect(await open()).toBeGreaterThan(1)
    expect(await open()).toBe(1)
  })
})
