import { createClient } from "@libsql/client"
import { createDatabaseEnvStore } from "@vite-hub/env/database"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/libsql"
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core"
import { afterEach, describe, expect, it, vi } from "vitest"

import { defaultActivityRetention } from "../src/internal/activity-retention.ts"
import { createDatabaseConnectionStore } from "../src/store.ts"
import { connect, createTestRuntime, mailConnection } from "./helpers.ts"

import type { EnvActivity } from "@vite-hub/env/bridge"
import type { EnvDatabase } from "@vite-hub/env/database"
import type { ConnectionActivityRetention } from "../src/types.ts"

const encryptionKey = new Uint8Array(32).fill(4)
const day = 24 * 60 * 60 * 1000
const clients: Array<ReturnType<typeof createClient>> = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) client.close()
})

function setup(activityRetention?: ConnectionActivityRetention | false) {
  const client = createClient({ url: ":memory:" })
  clients.push(client)
  const db = drizzle(client)
  return { db, store: createDatabaseConnectionStore({ activityRetention, db, encryptionKey }) }
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
  it("keeps 14 days and 10,000 events by default", () => {
    expect(defaultActivityRetention).toEqual({ maxAgeMs: 14 * day, maxRecords: 10_000 })
  })

  it("drops events older than 14 days by default", async () => {
    const { db, store } = setup()
    const envStore = createDatabaseEnvStore({ db, encryptionKey, namespace: "connections" })
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
    const envStore = createDatabaseEnvStore({ db, encryptionKey, namespace: "connections" })
    const events = [event(), event(), event()]
    for (const item of events) await envStore.access.append(item)
    const current = event()
    await store.access.append(current)
    expect(await ids(db)).toEqual([events[2]!.id, current.id])
  })

  it("drops events older than maxAgeMs", async () => {
    const { db, store } = setup({ maxAgeMs: 60_000 })
    const envStore = createDatabaseEnvStore({ db, encryptionKey, namespace: "connections" })
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
    expect(() => setup(activityRetention)).toThrow(expect.objectContaining({ code: "CONNECTION_INVALID", message: expect.stringMatching(/activityRetention\.max(AgeMs|Records) must be a positive integer/) }))
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
    // Each request writes activity and triggers pruning.
    for (let index = 0; index < 150; index += 1) await client.call("mail.labels.list", { userId: "me" })
    expect((await ids(db)).length).toBe(1)
  })

  it("logs a warning and keeps the event when pruning fails", async () => {
    const { db } = setup(false)
    const dialect = new SQLiteAsyncDialect()
    const failingPrune: EnvDatabase = {
      all: query => db.all(query),
      run: query => dialect.sqlToQuery(query).sql.startsWith("DELETE FROM vitehub_env_activity") ? Promise.reject(new Error("database is locked")) : db.run(query),
    }
    const store = createDatabaseConnectionStore({ db: failingPrune, encryptionKey })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const current = event()
    await expect(store.access.append(current)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not prune old activity"), expect.objectContaining({ message: "database is locked" }))
    expect(await ids(db)).toEqual([current.id])
  })

  it("never deletes activity of other namespaces", async () => {
    const { db, store } = setup({ maxAgeMs: 1, maxRecords: 1 })
    const other = createDatabaseEnvStore({ db, encryptionKey, namespace: "default" })
    const otherEvents = [event(new Date(Date.now() - 365 * day).toISOString()), event(), event()]
    for (const item of otherEvents) await other.access.append(item)
    await store.access.append(event())
    expect(await ids(db, "default")).toEqual(otherEvents.map(item => item.id))
  })
})
