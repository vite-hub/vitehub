import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import { createKVLock } from "../src/runtime/lock.ts"
import { kv } from "../src/runtime/storage.ts"

import type { KVDatabasesLoader } from "../src/runtime/driver.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"
import type { KVLock, KVLockOptions, ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../src/types.ts"

// Locks on the real KV drivers. Each lock has its own store connection, as separate server processes have.
// Postgres and Redis run when VITEHUB_TEST_POSTGRES_URL and VITEHUB_TEST_REDIS_URL are set.

// Run the source driver, not the package build.
vi.mock("@vite-hub/kv/runtime/redis-driver", async () => await import("../src/runtime/redis-driver.ts"))
vi.setConfig({ testTimeout: 30_000 })

const fixture: { kv: false | ResolvedKVModuleOptions, loadDatabases?: KVDatabasesLoader } = { kv: false }
vi.mock("#vitehub/kv/config", () => ({
  get kv() { return fixture.kv },
  get loadDatabases() { return fixture.loadDatabases },
}))

const redisUrl = process.env.VITEHUB_TEST_REDIS_URL
const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const cleanups: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "vitehub-kv-lock-"))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
})

function track(storage: RuntimeStorage): RuntimeStorage {
  cleanups.push(() => storage.dispose())
  return storage
}

function libsqlDatabases(): KVDatabasesLoader {
  const client = createClient({ url: `file:${join(root, `${randomUUID()}.db`)}` })
  cleanups.push(async () => client.close())
  return async () => ({ default: { db: { $client: client } } })
}

interface Target {
  name: string
  /** `count` connections to one fresh, empty namespace. */
  stores(count: number): RuntimeStorage[]
}

const databaseStores = (count: number, client: () => object) => {
  const store: ResolvedKVStoreConfig = { driver: "database", database: "default", namespace: `test-${randomUUID()}` }
  return Array.from({ length: count }, () => {
    const db = { $client: client() }
    return track(createHostedKVStorage({ store }, "default", async () => ({ default: { db } })))
  })
}

const targets: Target[] = [
  {
    name: "database on libSQL",
    stores(count) {
      const url = `file:${join(root, `${randomUUID()}.db`)}`
      return databaseStores(count, () => {
        const client = createClient({ url })
        cleanups.push(async () => client.close())
        return client
      })
    },
  },
  ...postgresUrl
    ? [{
        name: "database on Postgres",
        stores: (count: number) => databaseStores(count, () => {
          const sql = postgres(postgresUrl, { max: 2, onnotice: () => {} })
          cleanups.push(() => sql.end())
          return sql
        }),
      }]
    : [],
  ...redisUrl
    ? [{
        name: "redis",
        stores(count: number) {
          const store: ResolvedKVStoreConfig = { driver: "redis", base: `test-${randomUUID()}`, url: redisUrl }
          return Array.from({ length: count }, () => track(createHostedKVStorage({ store })))
        },
      }]
    : [],
]

/** One lock per connection, as each server process would create it. */
function locks(target: Target, count: number, key: string, options: KVLockOptions): KVLock[] {
  return target.stores(count).map(storage => createKVLock("default", async () => storage, key, options))
}

describe("kv.lock()", () => {
  it("runs the callback in one of two concurrent runners", async () => {
    fixture.kv = { store: { driver: "database", database: "default", namespace: `test-${randomUUID()}` } }
    fixture.loadDatabases = libsqlDatabases()
    const ran: string[] = []
    const job = (name: string) => kv.lock("cron:daily", { ttl: 30 }).run(async () => {
      ran.push(name)
      await sleep(100)
      return name
    })

    const results = await Promise.all([job("a"), job("b")])

    expect(ran).toHaveLength(1)
    expect(results.map(([error]) => error)).toEqual([undefined, undefined])
    expect(results.map(([, data]) => data)).toContainEqual({ acquired: true, value: ran[0] })
    expect(results.map(([, data]) => data)).toContainEqual({ acquired: false })
    // run() released the lock, so the next run gets it.
    expect(await kv.lock("cron:daily", { ttl: 30 }).run(() => "next")).toEqual([undefined, { acquired: true, value: "next" }])
  })

  it("returns KV_UNSUPPORTED_OPERATION on a driver without deleteIfEquals and does not call the callback", async () => {
    fixture.kv = {
      store: { driver: "database", database: "default", namespace: `test-${randomUUID()}` },
      stores: {
        default: { driver: "database", database: "default", namespace: `test-${randomUUID()}` },
        files: { driver: "fs-lite", base: join(root, randomUUID()) },
      },
    }
    fixture.loadDatabases = libsqlDatabases()
    const callback = vi.fn()

    const [error, data] = await kv.store("files").lock("cron:daily", { ttl: 30 }).run(callback)

    expect(data).toBeUndefined()
    expect(error).toMatchObject({ code: "KV_UNSUPPORTED_OPERATION" })
    expect(error?.fix).toContain("`redis`, `database`, or `upstash`")
    expect(callback).not.toHaveBeenCalled()
    expect((await kv.store("files").lock("cron:daily", { ttl: 30 }).acquire())[0]).toMatchObject({ code: "KV_UNSUPPORTED_OPERATION" })
  })

  it("rejects an invalid ttl or wait before it touches the store", async () => {
    expect((await kv.lock("job", { ttl: 0 }).run(() => 1))[0]).toMatchObject({ code: "KV_INVALID_TTL" })
    expect((await kv.lock("job", { ttl: Number.NaN }).acquire())[0]).toMatchObject({ code: "KV_INVALID_TTL" })
    expect((await kv.lock("job", { ttl: 30, wait: -1 }).run(() => 1))[0]).toMatchObject({ code: "KV_INVALID_WAIT" })
  })
})

describe.each(targets)("lock on $name", (target) => {
  it("rejects a successful claim delivered after its lease expires", async () => {
    const [first, second] = target.stores(2)
    let deliver!: () => void
    let committed!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const commit = new Promise<void>(resolve => { committed = resolve })
    const claim = first.setIfAbsentItem!
    first.setIfAbsentItem = async (...args) => {
      const result = await claim(...args)
      committed()
      await delivery
      return result
    }
    const callback = vi.fn()
    const pending = createKVLock("default", async () => first, "delayed", { ttl: 0.05 }).run(callback)
    await commit
    // Deliver only after the successor has acquired the expired lease.
    const [, successor] = await createKVLock("default", async () => second, "delayed", { ttl: 30, wait: 1 }).acquire()
    expect(successor?.acquired).toBe(true)
    deliver()
    expect(await pending).toEqual([undefined, { acquired: false }])
    expect(callback).not.toHaveBeenCalled()
    // Cleanup of the old claim must preserve the successor's owner token.
    expect(await createKVLock("default", async () => first, "delayed", { ttl: 30 }).acquire()).toEqual([undefined, { acquired: false }])
    if (successor?.acquired) expect(await successor.release()).toEqual([undefined, true])
  })

  it("lets one of many concurrent runners run", async () => {
    let ran = 0
    let returned = 0
    const results = await Promise.all(locks(target, 5, "job", { ttl: 30 }).map(lock => lock.run(async () => {
      ran++
      // Hold the lock until the other runners gave up, so none can take it after this release.
      const deadline = Date.now() + 10_000
      while (returned < 4 && Date.now() < deadline) await sleep(10)
    }).finally(() => { returned++ })))

    expect(ran).toBe(1)
    expect(results.filter(([, data]) => data?.acquired)).toHaveLength(1)
    expect(results.every(([error]) => error === undefined)).toBe(true)
  })

  it("releases the lock when the callback throws, and rethrows the error", async () => {
    const [first, second] = locks(target, 2, "job", { ttl: 30 })
    const failure = new Error("job failed")

    await expect(first!.run(() => { throw failure })).rejects.toBe(failure)
    expect(await second!.run(() => "ran")).toEqual([undefined, { acquired: true, value: "ran" }])
  })

  it("lets the next runner in after the ttl, and the expired holder cannot free the new lock", async () => {
    const [first, second, third] = target.stores(3)
    const [firstError, held] = await createKVLock("default", async () => first!, "job", { ttl: 0.3 }).acquire()
    expect(firstError).toBeUndefined()
    expect(held?.acquired).toBe(true)
    expect((await createKVLock("default", async () => second!, "job", { ttl: 30 }).acquire())[1]).toEqual({ acquired: false })

    await sleep(500)
    const [secondError, next] = await createKVLock("default", async () => second!, "job", { ttl: 30 }).acquire()
    expect(secondError).toBeUndefined()
    expect(next?.acquired).toBe(true)

    // The first holder's lock expired. Its release must not delete the second holder's lock.
    expect(held?.acquired && await held.release()).toEqual([undefined, false])
    expect((await createKVLock("default", async () => third!, "job", { ttl: 30 }).acquire())[1]).toEqual({ acquired: false })
    expect(next?.acquired && await next.release()).toEqual([undefined, true])
    expect((await createKVLock("default", async () => third!, "job", { ttl: 30 }).run(() => 1))[1]).toEqual({ acquired: true, value: 1 })
  })

  it("waits for a held lock up to `wait` seconds", async () => {
    const [holder, waiter] = locks(target, 2, "job", { ttl: 30, wait: 5 })
    const [, held] = await holder!.acquire()
    expect(held?.acquired).toBe(true)
    setTimeout(() => { if (held?.acquired) void held.release() }, 300)

    const started = Date.now()
    expect(await waiter!.run(() => "after release")).toEqual([undefined, { acquired: true, value: "after release" }])
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it("gives up after `wait` seconds while the lock stays held", async () => {
    const [holder, waiter] = target.stores(2)
    await createKVLock("default", async () => holder!, "job", { ttl: 30 }).acquire()

    const started = Date.now()
    const result = await createKVLock("default", async () => waiter!, "job", { ttl: 30, wait: 0.3 }).run(() => "never")

    expect(result).toEqual([undefined, { acquired: false }])
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})
