import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { createClient } from "@libsql/client"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createMemoryLeaseStore, createSqlLeaseStore, leaseTable } from "../src/lease.ts"

import type { LeaseSqlClient, LeaseStore } from "../src/lease.ts"

const execFileAsync = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Unwraps a `[error, data]` result, so a store failure fails the test with its cause. */
function ok<T>([error, data]: [unknown, T]): T {
  if (error) throw error
  return data
}

interface Target {
  name: string
  /** A store on a fresh, empty lease table. */
  store(): Promise<LeaseStore>
  /** Separate stores on one fresh table, each with its own connection, as separate processes have. */
  stores?(count: number): Promise<LeaseStore[]>
}

const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const cleanups: (() => Promise<void>)[] = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

let sqliteRoot: string
beforeAll(async () => {
  sqliteRoot = await mkdtemp(join(tmpdir(), "vitehub-lease-"))
  cleanups.push(() => rm(sqliteRoot, { force: true, recursive: true }))
})

let sqliteFiles = 0
const postgresClient = (url: string): LeaseSqlClient => {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  cleanups.push(() => sql.end())
  return { dialect: "postgresql", query: async (text, params) => await sql.unsafe(text, params) }
}

const targets: Target[] = [
  { name: "memory", store: async () => createMemoryLeaseStore() },
  libsqlTarget(),
  ...(postgresUrl ? [postgresTarget(postgresUrl)] : []),
]

function libsqlClient(file: string): LeaseSqlClient {
  // Separate libSQL clients in one process run their statements one at a time, so they never meet SQLITE_BUSY. A local
  // libSQL file client is for one process only; the cross-process tests use node:sqlite.
  const client = createClient({ url: `file:${file}` })
  cleanups.push(async () => client.close())
  return { dialect: "sqlite", query: async (sql, args) => (await client.execute({ sql, args })).rows }
}

function libsqlTarget(): Target {
  async function stores(count: number) {
    const file = join(sqliteRoot, `leases-${++sqliteFiles}.db`)
    return Array.from({ length: count }, () => createSqlLeaseStore(libsqlClient(file)))
  }
  return { name: "libSQL", store: async () => (await stores(1))[0]!, stores }
}

function postgresTarget(url: string): Target {
  async function stores(count: number) {
    const admin = postgres(url, { max: 1, onnotice: () => {} })
    await admin.unsafe(`drop table if exists ${leaseTable}`)
    await admin.end()
    return Array.from({ length: count }, () => createSqlLeaseStore(postgresClient(url)))
  }
  return { name: "Postgres", store: async () => (await stores(1))[0]!, stores }
}

describe.each(targets)("$name lease store", (target) => {
  it("gives a free key to one caller and refuses the others", async () => {
    const store = await target.store()
    const lease = ok(await store.acquire("report:daily", { ttl: 30, owner: "instance-a" }))

    expect(lease).toMatchObject({ key: "report:daily", owner: "instance-a" })
    expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 25_000)
    expect(ok(await store.acquire("report:daily", { ttl: 30, owner: "instance-a" }))).toBeNull()
    expect(ok(await store.acquire("report:daily", { ttl: 30, owner: "instance-b" }))).toBeNull()
    expect(ok(await store.get("report:daily"))).toEqual({ key: "report:daily", id: lease!.id, owner: "instance-a", expiresAt: lease!.expiresAt })
    expect(ok(await store.acquire("report:weekly", { ttl: 30 }))).toMatchObject({ key: "report:weekly" })
  })

  it("frees the key on release", async () => {
    const store = await target.store()
    const lease = ok(await store.acquire("job", { ttl: 30 }))!

    expect(ok(await lease.release())).toBe(true)
    expect(ok(await store.get("job"))).toBeNull()
    expect(ok(await lease.release())).toBe(false)
    expect(ok(await store.acquire("job", { ttl: 30 }))).not.toBeNull()
  })

  it("lets a new owner in after the TTL, and the old holder cannot release or renew it", async () => {
    const store = await target.store()
    const old = ok(await store.acquire("job", { ttl: 0.2, owner: "old" }))!
    await sleep(400)

    const next = ok(await store.acquire("job", { ttl: 30, owner: "new" }))!
    expect(next).toMatchObject({ owner: "new" })
    expect(next.id).not.toBe(old.id)
    expect(ok(await old.release())).toBe(false)
    expect(ok(await old.renew())).toBe(false)
    expect(ok(await store.get("job"))).toMatchObject({ id: next.id, owner: "new" })
  })

  it("keeps a renewed lease past its first TTL", async () => {
    const store = await target.store()
    const lease = ok(await store.acquire("leader", { ttl: 0.4 }))!
    const first = lease.expiresAt.getTime()

    await sleep(200)
    expect(ok(await lease.renew({ ttl: 30 }))).toBe(true)
    expect(lease.expiresAt.getTime()).toBeGreaterThan(first)
    await sleep(400)
    expect(ok(await store.acquire("leader", { ttl: 30 }))).toBeNull()
    expect(ok(await store.get("leader"))?.id).toBe(lease.id)
  })

  it("gives one key to exactly one of many concurrent callers", async () => {
    const stores = target.stores ? await target.stores(8) : [await target.store()]
    const attempts = await Promise.all(Array.from({ length: 64 }, (_, index) =>
      stores[index % stores.length]!.acquire("schedule:nightly:2026-11-09", { ttl: 30, owner: `caller-${index}` })))

    const winners = attempts.map(ok).filter(lease => lease !== null)
    expect(winners).toHaveLength(1)
    expect(ok(await stores[0]!.get("schedule:nightly:2026-11-09"))).toMatchObject({ id: winners[0]!.id })
  }, 30_000)

  it("gives an expired lease to exactly one of many concurrent callers", async () => {
    const stores = target.stores ? await target.stores(8) : [await target.store()]
    const expired = ok(await stores[0]!.acquire("leader", { ttl: 0.2, owner: "crashed" }))!
    await sleep(400)

    const attempts = await Promise.all(Array.from({ length: 64 }, (_, index) =>
      stores[index % stores.length]!.acquire("leader", { ttl: 30, owner: `caller-${index}` })))

    const winners = attempts.map(ok).filter(lease => lease !== null)
    expect(winners).toHaveLength(1)
    expect(ok(await expired.release())).toBe(false)
    expect(ok(await stores[0]!.get("leader"))).toMatchObject({ id: winners[0]!.id })
  }, 30_000)

  it("rejects a TTL that is not a positive number of seconds", async () => {
    const store = await target.store()
    for (const ttl of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const [error] = await store.acquire("job", { ttl })
      expect(error).toMatchObject({ code: "RUNTIME_LEASE_INVALID_TTL" })
    }
    const lease = ok(await store.acquire("job", { ttl: 30 }))!
    expect((await lease.renew({ ttl: 0 }))[0]).toMatchObject({ code: "RUNTIME_LEASE_INVALID_TTL" })
  })
})

describe.skipIf(!postgresUrl)("Postgres lease lock waits", () => {
  it.each(["acquire", "renew"] as const)("starts the %s TTL after obtaining the row lock", async (operation) => {
    const options = { max: 1, onnotice: () => {} }
    const sql = postgres(postgresUrl!, options)
    const blocker = postgres(postgresUrl!, options)
    const observer = postgres(postgresUrl!, options)
    cleanups.push(() => sql.end(), () => blocker.end(), () => observer.end())
    await sql.unsafe(`drop table if exists ${leaseTable}`)
    const store = createSqlLeaseStore({ dialect: "postgresql", query: async (text, params) => await sql.unsafe(text, params) })
    // Warm the store and its sweep before holding the row lock. Keep the expired row for the upsert case.
    const original = ok(await store.acquire("blocked-job", { ttl: 30 }))!
    if (operation === "acquire") await sql.unsafe(`update ${leaseTable} set expires_at = 0 where "key" = 'blocked-job'`)
    const [connection] = await sql.unsafe("select pg_backend_pid() as pid")
    await blocker.unsafe("begin")
    let pending: Promise<unknown> | undefined
    try {
      await blocker.unsafe(`select "key" from ${leaseTable} where "key" = 'blocked-job' for update`)
      const result = (async () => {
        if (operation === "acquire") return ok(await store.acquire("blocked-job", { ttl: 0.2 }))
        expect(ok(await original.renew({ ttl: 0.2 }))).toBe(true)
        return original
      })()
      pending = result
      // Confirm that the actual lease statement is blocked, rather than relying on a client-side start time.
      await expect.poll(async () => {
        const [row] = await observer.unsafe("select cardinality(pg_blocking_pids($1)) > 0 as blocked", [connection!.pid])
        return row!.blocked
      }).toBe(true)
      await observer.unsafe("select pg_sleep(0.7)")
      await blocker.unsafe("commit")

      const held = await result
      expect(held).not.toBeNull()
      const [row] = await observer.unsafe(`select id, expires_at - (extract(epoch from clock_timestamp()) * 1000)::bigint as remaining from ${leaseTable} where "key" = 'blocked-job'`)
      expect(Number(row!.remaining)).toBeGreaterThan(0)
      expect(row!.id).toBe(held!.id)
      expect(ok(await store.get("blocked-job"))).toMatchObject({ id: held!.id, expiresAt: held!.expiresAt })
      expect(ok(await store.acquire("blocked-job", { ttl: 30 }))).toBeNull()
    }
    finally {
      await blocker.unsafe("rollback")
      await pending
    }
  })
})

describe("node:sqlite lease store across processes", () => {
  // Only separate processes contend for the SQLite lock. A local libSQL file client is not tested here: after
  // SQLITE_BUSY it can lose writes that it reported as done, so the README limits it to one process.
  type Outcome = { error: string, cause: string } | { id: string } | null
  const fixture = fileURLToPath(new URL("./fixtures/lease-sqlite-process.ts", import.meta.url))

  async function race(file: string, key: string): Promise<Outcome[]> {
    const startAt = Date.now() + 1_500
    const outputs = await Promise.all(Array.from({ length: 8 }, async () => {
      const { stdout } = await execFileAsync(process.execPath, [fixture, file, key, "4", String(startAt), "30"])
      return JSON.parse(stdout) as Outcome[]
    }))
    return outputs.flat()
  }

  it("gives a free key and an expired lease to exactly one of 8 processes, with no busy errors", async () => {
    const file = join(sqliteRoot, "processes.db")
    const db = new DatabaseSync(file)
    cleanups.push(async () => db.close())
    const store = createSqlLeaseStore({ dialect: "sqlite", query: async (sql, params) => db.prepare(sql).all(...params) })

    const free = await race(file, "nightly")
    expect(free.filter(outcome => outcome && "error" in outcome)).toEqual([])
    const first = free.filter(outcome => outcome && "id" in outcome)
    expect(first).toHaveLength(1)
    // Read the committed row from another connection, so a write that SQLite rolled back cannot pass.
    expect(ok(await store.get("nightly"))).toMatchObject(first[0]!)

    const crashed = ok(await store.acquire("leader", { ttl: 0.2, owner: "crashed" }))!
    await sleep(400)
    const expired = await race(file, "leader")
    expect(expired.filter(outcome => outcome && "error" in outcome)).toEqual([])
    const winners = expired.filter(outcome => outcome && "id" in outcome)
    expect(winners).toHaveLength(1)
    expect(ok(await crashed.release())).toBe(false)
    expect(ok(await store.get("leader"))).toMatchObject(winners[0]!)
  }, 60_000)
})

describe("SQL lease store", () => {
  it("returns RUNTIME_LEASE_FAILED with the Database error as cause", async () => {
    const cause = new Error("connection refused")
    const store = createSqlLeaseStore({ dialect: "postgresql", query: async () => { throw cause } })

    const [error, lease] = await store.acquire("job", { ttl: 30 })

    expect(lease).toBeUndefined()
    expect(error).toMatchObject({ code: "RUNTIME_LEASE_FAILED", cause })
    expect(error?.message).toContain("could not acquire the lease \"job\"")
  })

  it("writes Postgres placeholders in order and creates the table once under a lock", async () => {
    const statements: { sql: string, params: unknown[] }[] = []
    const store = createSqlLeaseStore({
      dialect: "postgresql",
      async query(sql, params) {
        statements.push({ sql, params })
        if (sql.startsWith("select 1")) throw new Error("relation does not exist")
        return sql.startsWith("insert") ? [{ id: params[1], expires_at: "1800000000000" }] : []
      },
    })

    const lease = ok(await store.acquire("job", { ttl: 1.5, owner: "a" }))!
    ok(await store.acquire("other", { ttl: 1 }))

    expect(lease.expiresAt).toEqual(new Date(1_800_000_000_000))
    const ddl = statements.filter(statement => statement.sql.includes("create table"))
    expect(ddl).toHaveLength(1)
    expect(ddl[0]!.sql).toContain("pg_advisory_xact_lock")
    const insert = statements.find(statement => statement.sql.startsWith("insert"))!
    expect(insert.sql).toContain("values ($1, $2, $3, (extract(epoch from clock_timestamp()) * 1000)::bigint + cast($4 as bigint))")
    expect(insert.sql).not.toContain("?")
    expect(insert.params).toEqual(["job", lease.id, "a", 1500, 1500])
  })
})
