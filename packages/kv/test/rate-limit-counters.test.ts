import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createRateLimiter } from "../../rate-limit/src/limiter.ts"
import { kvRateLimitDriver } from "../../rate-limit/src/drivers/kv.ts"
import { kvResult } from "../src/errors.ts"
import { kvTable } from "../src/runtime/database.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import { getKVStoreDriver, kv } from "../src/runtime/storage.ts"

import type { RateLimitKVStorage } from "../../rate-limit/src/drivers/kv.ts"
import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"
import type { ResolvedKVModuleOptions, ResolvedKVStoreConfig } from "../src/types.ts"

// The Rate Limit `kv` driver on the real KV drivers. Each store has its own connection, as separate server processes
// have. Postgres and Redis run when VITEHUB_TEST_POSTGRES_URL and VITEHUB_TEST_REDIS_URL are set.

// Run the source driver, not the package build.
vi.mock("@vite-hub/kv/runtime/redis-driver", async () => await import("../src/runtime/redis-driver.ts"))
vi.setConfig({ testTimeout: 30_000 })

const fixture: { kv: false | ResolvedKVModuleOptions } = { kv: false }
vi.mock("#vitehub/kv/config", () => ({ get kv() { return fixture.kv } }))

const redisUrl = process.env.VITEHUB_TEST_REDIS_URL
const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const cleanups: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

function track(storage: RuntimeStorage): RuntimeStorage {
  cleanups.push(() => storage.dispose())
  return storage
}

/** The `[error, data]` API of `kv`, on one store connection. */
function counterStorage(storage: RuntimeStorage): RateLimitKVStorage {
  return {
    delete: key => kvResult("delete", "default", () => storage.removeItem(key)),
    get: key => kvResult("get", "default", () => storage.getItem(key)),
    increment: (key, ttl) => kvResult("increment", "default", () => storage.incrementItem!(key, ttl)),
  }
}

const databaseStores = (count: number, client: () => object) => {
  const store: ResolvedKVStoreConfig = { driver: "database", database: "default", namespace: `test-${randomUUID()}` }
  return Array.from({ length: count }, () => {
    const db = { $client: client() }
    return track(createHostedKVStorage({ store }, "default", async () => ({ default: { db } })))
  })
}

let sqliteRoot: string
beforeAll(async () => {
  sqliteRoot = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-kv-"))
  cleanups.push(() => rm(sqliteRoot, { force: true, recursive: true }))
})

const targets: { name: string, stores: (count: number) => RuntimeStorage[] }[] = [
  {
    name: "database on libSQL",
    stores(count) {
      const url = `file:${join(sqliteRoot, `${randomUUID()}.db`)}`
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

describe.each(targets)("Rate Limit kv driver on $name", (target) => {
  it("allows exactly 10 of 60 concurrent requests over three clients", async () => {
    const now = Date.now()
    const name = `uploads-${randomUUID()}`
    const limiters = target.stores(3).map(storage => createRateLimiter({
      driver: kvRateLimitDriver({ now: () => now, storage: counterStorage(storage) }),
      enforcement: "strict",
      limit: 10,
      name,
      window: "1m",
    }))
    // Two batches of 30 at the same time, spread over the three clients.
    const batch = () => Promise.all(Array.from({ length: 30 }, (_, index) => limiters[index % 3]!.consume({ key: "198.51.100.7" })))
    const decisions = (await Promise.all([batch(), batch()])).flat()

    const allowed = decisions.filter(decision => decision.allowed)
    expect(allowed).toHaveLength(10)
    expect(allowed.map(decision => decision.used).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 10 }, (_, index) => index + 1))
    expect(decisions.filter(decision => !decision.allowed).every(decision => decision.reason === "limited")).toBe(true)
    await expect(limiters[1]!.peek({ key: "198.51.100.7" })).resolves.toMatchObject({ remaining: 0, used: 60 })
  })

  it("expires a window with its TTL, so the next request starts a new window", async () => {
    // The clock stays in one window, so only the TTL can remove the counter.
    const now = Date.now()
    const name = `ttl-${randomUUID()}`
    const [first, second] = target.stores(2).map(storage => createRateLimiter({ driver: kvRateLimitDriver({ now: () => now, storage: counterStorage(storage) }), limit: 2, name, window: "1s" }))
    await expect(first!.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(second!.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, used: 2 })
    await expect(first!.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, used: 3 })

    // Redis rounds the TTL up to whole seconds.
    await sleep(1_300)
    await expect(second!.peek({ key: "user" })).resolves.toMatchObject({ used: 0 })
    await expect(second!.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, used: 1 })
  })

  it("counts a client key that KV would reject as a key segment", async () => {
    const [storage] = target.stores(1)
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: counterStorage(storage!) }), failure: "allow", limit: 1, name: `dots-${randomUUID()}`, window: "1m" })
    await expect(limiter.consume({ key: ".." })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(limiter.consume({ key: ".." })).resolves.toMatchObject({ allowed: false, reason: "limited" })
  })

  it("keeps a 1m and a 1h counter of one name apart when their windows start together", async () => {
    // 12:00:00 starts a minute window and an hour window.
    const now = Date.UTC(2026, 10, 9, 12, 0, 0)
    const [storage] = target.stores(1)
    const minute = createRateLimiter({ driver: kvRateLimitDriver({ now: () => now, storage: counterStorage(storage!) }), limit: 1, window: "1m" })
    const hour = createRateLimiter({ driver: kvRateLimitDriver({ now: () => now, storage: counterStorage(storage!) }), limit: 1, window: "1h" })
    const key = randomUUID()
    await expect(minute.consume({ key })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(hour.consume({ key })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(minute.peek({ key })).resolves.toMatchObject({ used: 1 })
    await expect(hour.reset({ key })).resolves.toEqual({ status: "reset" })
    await expect(minute.peek({ key })).resolves.toMatchObject({ used: 1 })
    await expect(hour.peek({ key })).resolves.toMatchObject({ used: 0 })
  })

  it("resets the counter for every client", async () => {
    const name = `reset-${randomUUID()}`
    const now = Date.now()
    const [first, second] = target.stores(2).map(storage => createRateLimiter({ driver: kvRateLimitDriver({ now: () => now, storage: counterStorage(storage) }), limit: 1, name, window: "1m" }))
    await expect(first!.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
    await expect(second!.consume({ key: "user" })).resolves.toMatchObject({ allowed: false })
    await expect(second!.reset({ key: "user" })).resolves.toEqual({ status: "reset" })
    await expect(first!.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
  })
})

describe("Rate Limit kv driver on the database KV driver", () => {
  const config = (): Extract<ResolvedKVStoreConfig, { driver: "database" }> => ({ driver: "database", database: "default", namespace: `sweep-${randomUUID()}` })
  const rawTargets: { name: string, create: () => { rows: () => Promise<number>, storage: RuntimeStorage } }[] = [
    {
      name: "libSQL",
      create() {
        const client = createClient({ url: `file:${join(sqliteRoot, `${randomUUID()}.db`)}` })
        cleanups.push(async () => client.close())
        const store = config()
        const storage = track(createHostedKVStorage({ store }, "default", async () => ({ default: { db: { $client: client } } })))
        const rows = async () => Number((await client.execute({ sql: `select count(*) as count from ${kvTable} where namespace = ?`, args: [store.namespace] })).rows[0]!.count)
        return { rows, storage }
      },
    },
    ...postgresUrl
      ? [{
          name: "Postgres",
          create() {
            const sql = postgres(postgresUrl, { max: 2, onnotice: () => {} })
            cleanups.push(() => sql.end())
            const store = config()
            const storage = track(createHostedKVStorage({ store }, "default", async () => ({ default: { db: { $client: sql } } })))
            const rows = async () => Number((await sql.unsafe(`select count(*) as count from ${kvTable} where namespace = $1`, [store.namespace]))[0]!.count)
            return { rows, storage }
          },
        }]
      : [],
  ]

  it.each(rawTargets)("does not grow the table over many windows on $name", async (target) => {
    const { rows, storage } = target.create()
    let window = Math.floor(Date.now() / 1_000) * 1_000
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ now: () => window, storage: counterStorage(storage) }), limit: 5, name: "sweep", window: "1s" })
    const start = Date.now()
    for (let round = 0; round < 3; round++) {
      // The database sweeps expired rows at most once a minute, so each round moves that clock past the next sweep.
      const clock = vi.spyOn(Date, "now").mockReturnValue(start + round * 61_000)
      try {
        for (const client of ["a", "b", "c"]) await expect(limiter.consume({ key: client })).resolves.toMatchObject({ allowed: true, used: 1 })
      }
      finally {
        clock.mockRestore()
      }
      // Only the counters of the current window stay: one for each client.
      expect(await rows()).toBe(3)
      // The TTL is the window, so the Database clock expires these counters before the next round.
      await sleep(1_300)
      window += 1_000
    }
  })
})

describe("Rate Limit kv driver when Redis is down", () => {
  it.each([["deny", false], ["allow", true]] as const)("follows failure: %s", async (failure, allowed) => {
    // Nothing listens on port 1, so every command fails after the reconnect attempts.
    const storage = track(createHostedKVStorage({ store: { driver: "redis", base: "down", url: "redis://127.0.0.1:1" } }))
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: counterStorage(storage) }), failure, limit: 1, window: "1m" })
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed, reason: "unavailable" })
  })
})

describe("getKVStoreDriver", () => {
  it("accepts `kv` and `kv.store(name)` as Rate Limit storage", () => {
    // The generated Nitro plugin passes `kv`. The driver calls the store only when a request comes in.
    expect(kvRateLimitDriver({ storage: kv }).name).toBe("kv")
    expect(kvRateLimitDriver({ storage: kv.store("limits") }).name).toBe("kv")
  })

  it("names the driver that each store uses in this process", async () => {
    fixture.kv = {
      store: { base: join(tmpdir(), "vitehub-kv-unused"), driver: "fs-lite", inferred: true },
      stores: {
        default: { base: join(tmpdir(), "vitehub-kv-unused"), driver: "fs-lite", inferred: true },
        limits: { database: "default", driver: "database", namespace: "limits" },
        redis: { base: "limits", driver: "redis", url: "env:REDIS_URL" },
      },
    }
    vi.stubEnv("REDIS_URL", "")
    await expect(getKVStoreDriver()).resolves.toBe("fs-lite")
    await expect(getKVStoreDriver("limits")).resolves.toBe("database")
    // An unrelated URL cannot change the driver selected at build time.
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6379")
    await expect(getKVStoreDriver()).resolves.toBe("fs-lite")
    await expect(getKVStoreDriver("limits")).resolves.toBe("database")
    await expect(getKVStoreDriver("redis")).resolves.toBe("redis")
    await expect(getKVStoreDriver("missing")).rejects.toMatchObject({ code: "KV_STORE_NOT_FOUND" })
    vi.unstubAllEnvs()
  })
})
