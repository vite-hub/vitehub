import { createClient } from "@libsql/client"
import { createDatabaseEnvStore } from "@vite-hub/env/database"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { SQLiteDialect } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createDatabaseConnectionStore } from "../src/store.ts"
import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

import type { EnvActivity } from "@vite-hub/env/bridge"
import type { EnvDatabase } from "@vite-hub/env/database"
import type { ConnectionActivityRetention } from "../src/types.ts"

const encryptionKeys = [new Uint8Array(32).fill(4)]
const day = 24 * 60 * 60 * 1000
const clients: Array<ReturnType<typeof createClient>> = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.close()
})

function setup(activityRetention?: ConnectionActivityRetention | false) {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  const db = drizzle({ client: client })
  return { db, store: createDatabaseConnectionStore({ activityRetention, db, encryptionKeys }) }
}

let counter = 0
function event(timestamp = new Date().toISOString()): EnvActivity {
  counter += 1
  return { action: "use", actor: { id: "agent", kind: "agent" }, id: `event-${counter}`, key: "connection/mail", operation: "GET /messages", operationId: `operation-${counter}`, outcome: "succeeded", timestamp }
}

async function ids(db: ReturnType<typeof drizzle>, namespace = "connections"): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM vitehub_env_activity WHERE namespace = ${namespace} ORDER BY sequence`)
  return rows.map(row => row.id)
}

describe("Connection activity retention", () => {
  it("drops events older than 14 days by default", async () => {
    const { db, store } = setup()
    const envStore = createDatabaseEnvStore({ db, encryptionKeys, namespace: "connections" })
    const old = event(new Date(Date.now() - 15 * day).toISOString())
    const recent = event(new Date(Date.now() - 13 * day).toISOString())
    await envStore.access.append(old)
    await envStore.access.append(recent)
    const current = event()
    await store.access.append(current)
    expect(await ids(db)).toEqual([recent.id, current.id])
  })

  it("keeps the newest maxRecords events", async () => {
    const { db, store } = setup({ maxRecords: 2 })
    const envStore = createDatabaseEnvStore({ db, encryptionKeys, namespace: "connections" })
    const events = [event(), event(), event()]
    for (const item of events) await envStore.access.append(item)
    const current = event()
    await store.access.append(current)
    expect(await ids(db)).toEqual([events[2]!.id, current.id])
  })

  it("drops events older than maxAgeMs", async () => {
    const { db, store } = setup({ maxAgeMs: 60_000 })
    const envStore = createDatabaseEnvStore({ db, encryptionKeys, namespace: "connections" })
    await envStore.access.append(event(new Date(Date.now() - 120_000).toISOString()))
    const recent = event(new Date(Date.now() - 30_000).toISOString())
    await envStore.access.append(recent)
    const current = event()
    await store.access.append(current)
    expect(await ids(db)).toEqual([recent.id, current.id])
  })

  it("keeps all activity when retention is false", async () => {
    const { db, store } = setup(false)
    const old = event(new Date(Date.now() - 365 * day).toISOString())
    await store.access.append(old)
    const current = event()
    await store.access.append(current)
    expect(await ids(db)).toEqual([old.id, current.id])
  })

  it.each([{ maxRecords: 0 }, { maxRecords: 2.5 }, { maxAgeMs: 0 }, { maxAgeMs: -1 }, { maxAgeMs: Number.NaN }, { maxAgeMs: Number.MAX_SAFE_INTEGER + 1 }])("rejects %j", (activityRetention) => {
    expect(() => setup(activityRetention)).toThrow(expect.objectContaining({ code: "CONNECTIONS_INVALID_CONFIG", message: expect.stringMatching(/activityRetention\.max(AgeMs|Records) must be a positive integer/) }))
  })

  it("prunes after every event", async () => {
    const { db, store } = setup({ maxRecords: 1 })
    await store.access.append(event())
    expect(await ids(db)).toHaveLength(1)
    for (let index = 0; index < 99; index += 1) {
      await store.access.append(event())
      expect(await ids(db)).toHaveLength(1)
    }
  })

  it("prunes the activity that provider requests write", async () => {
    const { db, store } = setup({ maxRecords: 1 })
    const test = createTestRuntime(mailConnection(), store)
    test.now.value = Date.now()
    await connect(test)
    const client = test.runtime.client("mail", {})
    await client.call("mail.labels.list", { userId: "me" })
    expect(await ids(db)).toHaveLength(1)
    for (let index = 0; index < 150; index += 1) await client.call("mail.labels.list", { userId: "me" })
    expect((await ids(db)).length).toBe(1)
  })

  it("logs a warning and keeps the event when pruning fails", async () => {
    const { db } = setup(false)
    const dialect = new SQLiteDialect()
    const failingPrune: EnvDatabase = {
      all: query => db.all(query),
      run: query => dialect.sqlToQuery(query).sql.startsWith("DELETE FROM vitehub_env_activity") ? Promise.reject(new Error("database is locked")) : db.run(query),
    }
    const store = createDatabaseConnectionStore({ db: failingPrune, encryptionKeys })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const current = event()
    await expect(store.access.append(current)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not prune old activity"), expect.objectContaining({ message: "database is locked" }))
    expect(await ids(db)).toEqual([current.id])
  })

  it("prunes old events around a malformed payload and keeps the payload until the count cap drops it", async () => {
    const { db, store } = setup({ maxAgeMs: 60_000, maxRecords: 3 })
    const envStore = createDatabaseEnvStore({ db, encryptionKeys, namespace: "connections" })
    const old = event(new Date(Date.now() - 120_000).toISOString())
    const broken = event()
    await envStore.access.append(old)
    await envStore.access.append(broken)
    await db.run(sql`UPDATE vitehub_env_activity SET payload = '{' WHERE id = ${broken.id}`)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const current = event()
    await store.access.append(current)
    expect(warn).not.toHaveBeenCalled()
    expect(await ids(db)).toEqual([broken.id, current.id])
    const later = [event(), event()]
    for (const item of later) await store.access.append(item)
    expect(await ids(db)).toEqual([current.id, ...later.map(item => item.id)])
  })

  it("prunes an event written after a newer one by its own timestamp", async () => {
    const { db, store } = setup({ maxAgeMs: 60_000 })
    const envStore = createDatabaseEnvStore({ db, encryptionKeys, namespace: "connections" })
    const live = event()
    await envStore.access.append(live)
    await envStore.access.append(event(new Date(Date.now() - 120_000).toISOString()))
    const current = event()
    await store.access.append(current)
    expect(await ids(db)).toEqual([live.id, current.id])
  })

  it("adds its indexes to an activity table that an earlier version made", async () => {
    const { db, store } = setup({ maxAgeMs: 60_000, maxRecords: 10 })
    await db.run(sql`CREATE TABLE vitehub_env_activity (sequence INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL)`)
    await db.run(sql`CREATE INDEX vitehub_env_activity_key ON vitehub_env_activity (namespace, key, sequence)`)
    const old = event(new Date(Date.now() - 120_000).toISOString())
    await db.run(sql`INSERT INTO vitehub_env_activity (namespace, key, id, payload) VALUES ('connections', 'connection/mail', 'legacy-broken', '{'), ('connections', 'connection/mail', ${old.id}, ${JSON.stringify(old)})`)
    const current = event()
    await store.access.append(current)
    const indexes = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vitehub_env_activity' AND sql IS NOT NULL ORDER BY name`)
    expect(indexes.map(index => index.name)).toEqual(["vitehub_connections_activity_sequence", "vitehub_connections_activity_time", "vitehub_env_activity_key"])
    expect(await ids(db)).toEqual(["legacy-broken", current.id])
  })

  it("finds the events to prune through indexes, not a scan of the activity table", async () => {
    const { db } = setup()
    const dialect = new SQLiteDialect()
    const prunes: Array<{ params: unknown[], sql: string }> = []
    const recording: EnvDatabase = {
      all: query => db.all(query),
      run(query) {
        const built = dialect.sqlToQuery(query)
        if (built.sql.startsWith("DELETE FROM vitehub_env_activity")) prunes.push(built)
        return db.run(query)
      },
    }
    await createDatabaseConnectionStore({ db: recording, encryptionKeys }).access.append(event())
    expect(prunes).toHaveLength(1)
    const plan = await db.$client.execute({ args: prunes[0]!.params as Array<string | number>, sql: `EXPLAIN QUERY PLAN ${prunes[0]!.sql}` })
    const details = plan.rows.map(row => String(row.detail))
    expect(details.some(detail => detail.includes("vitehub_connections_activity_sequence"))).toBe(true)
    expect(details.some(detail => detail.includes("vitehub_connections_activity_time"))).toBe(true)
    expect(details.filter(detail => /^SCAN vitehub_env_activity\b/.test(detail))).toEqual([])
  })

  it("never deletes activity of other namespaces", async () => {
    const { db, store } = setup({ maxAgeMs: 1, maxRecords: 1 })
    const other = createDatabaseEnvStore({ db, encryptionKeys, namespace: "default" })
    const otherEvents = [event(new Date(Date.now() - 365 * day).toISOString()), event(), event()]
    for (const item of otherEvents) await other.access.append(item)
    await store.access.append(event())
    expect(await ids(db, "default")).toEqual(otherEvents.map(item => item.id))
  })
})
