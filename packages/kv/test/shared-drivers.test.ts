import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import { Redis } from "ioredis"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { kvTable } from "../src/runtime/database.ts"
import { normalizeKVOptions } from "../src/config.ts"
import { kvResult } from "../src/errors.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"

import type { RuntimeStorage } from "../src/runtime/hosted-storage.ts"
import type { ResolvedKVStoreConfig } from "../src/types.ts"

// Run the source driver, not the package build.
vi.mock("@vite-hub/kv/runtime/redis-driver", async () => await import("../src/runtime/redis-driver.ts"))
// Each test makes many round trips to a server or a SQLite file, which take longer when the machine is busy.
vi.setConfig({ testTimeout: 30_000 })

const redisUrl = process.env.VITEHUB_TEST_REDIS_URL
const postgresUrl = process.env.VITEHUB_TEST_POSTGRES_URL
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const cleanups: (() => Promise<unknown>)[] = []
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
})

interface Target {
  name: string
  /**
   * `count` stores on one fresh, empty namespace. Each store has its own connection, as separate server processes
   * have.
   */
  stores(count: number): Promise<RuntimeStorage[]>
}

function track(storage: RuntimeStorage): RuntimeStorage {
  cleanups.push(() => storage.dispose())
  return storage
}

/** A Database as `@vite-hub/database/runtime/registry` exports it: the KV driver reads only `$client`. */
const databaseStores = (count: number, client: () => object) => {
  const namespace = `test-${randomUUID()}`
  const store: ResolvedKVStoreConfig = { driver: "database", database: "default", namespace }
  return Promise.all(Array.from({ length: count }, async () => {
    const db = { $client: client() }
    return track(createHostedKVStorage({ store }, "default", async () => ({ default: { db } })))
  }))
}

let sqliteRoot: string
beforeAll(async () => {
  sqliteRoot = await mkdtemp(join(tmpdir(), "vitehub-kv-database-"))
  cleanups.push(() => rm(sqliteRoot, { force: true, recursive: true }))
})

const targets: Target[] = [
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
        async stores(count: number) {
          const base = `test-${randomUUID()}`
          const store: ResolvedKVStoreConfig = { driver: "redis", base, url: redisUrl }
          return Array.from({ length: count }, () => track(createHostedKVStorage({ store })))
        },
      }]
    : [],
]

describe.each(targets)("$name", (target) => {
  it("reads, writes, lists, and clears keys", async () => {
    const [storage] = await target.stores(1)
    await storage!.setItem("users:alice", { name: "Alice" })
    await storage!.setItem("users:bob", "Bob")
    await storage!.setItem("settings", 123)

    expect(await storage!.getItem("users:alice")).toEqual({ name: "Alice" })
    expect(await storage!.getItem("settings")).toBe(123)
    expect(await storage!.getItem("missing")).toBeNull()
    expect(await storage!.hasItem("users:bob")).toBe(true)
    expect((await storage!.getKeys("users")).sort()).toEqual(["users:alice", "users:bob"])

    const first = await storage!.listKeys({ limit: 1, prefix: "users:" })
    const keys = [...first.keys]
    let cursor = first.cursor
    while (cursor) {
      const page = await storage!.listKeys({ cursor, limit: 1, prefix: "users:" })
      keys.push(...page.keys)
      cursor = page.cursor
    }
    expect(keys.sort()).toEqual(["users:alice", "users:bob"])

    await storage!.removeItem("settings")
    expect(await storage!.hasItem("settings")).toBe(false)
    await storage!.clear("users")
    expect(await storage!.getKeys()).toEqual([])
  })

  it("reads and writes many keys in one call", async () => {
    const [storage] = await target.stores(1)
    const entries = Array.from({ length: 450 }, (_, index) => ({ key: `item:${index}`, value: { index } }))
    await storage!.setMany([...entries, { key: "item:0", value: "last" }], { ttl: 60 })
    const values = await storage!.getMany([...entries.map(entry => entry.key), "missing", "item:1"])
    expect(values).toEqual(["last", ...entries.slice(1).map(entry => entry.value), null, { index: 1 }])
    await expect(storage!.getMany(["item:2"], { type: "text" })).resolves.toEqual(["{\"index\":2}"])
    await storage!.setMany([{ key: "item:0", value: undefined }])
    await expect(storage!.getMany(["item:0"])).resolves.toEqual([null])
  })

  it("keeps the stores of two namespaces apart", async () => {
    const [left] = await target.stores(1)
    const [right] = await target.stores(1)
    await left!.setItem("shared", "left")
    expect(await right!.getItem("shared")).toBeNull()
    await right!.clear()
    expect(await left!.getItem("shared")).toBe("left")
  })

  it("gives exactly one winner when two clients race setIfAbsent() on one key", async () => {
    for (let round = 0; round < 5; round++) {
      const stores = await target.stores(2)
      const results = await Promise.all(stores.map((storage, index) => storage.setIfAbsentItem!("ticket", `writer-${index}`, 30)))
      expect(results.filter(Boolean)).toHaveLength(1)
      const winner = results.indexOf(true)
      expect(await stores[0]!.getItem("ticket")).toBe(`writer-${winner}`)
    }
  })

  it("gives exactly one winner when many clients race setIfAbsent()", async () => {
    const stores = await target.stores(4)
    const results = await Promise.all(stores.flatMap(storage => Array.from({ length: 5 }, () => storage.setIfAbsentItem!("invite", "taken"))))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("expires keys after their TTL, and setIfAbsent() treats an expired key as absent", async () => {
    const [storage] = await target.stores(1)
    await storage!.setItem("session", "live", { ttl: 0.5 })
    expect(await storage!.setIfAbsentItem!("nonce", "first", 0.5)).toBe(true)
    expect(await storage!.setIfAbsentItem!("nonce", "second", 0.5)).toBe(false)
    expect(await storage!.getItem("session")).toBe("live")

    await sleep(800)
    expect(await storage!.getItem("session")).toBeNull()
    expect(await storage!.hasItem("session")).toBe(false)
    expect(await storage!.getKeys()).toEqual([])
    expect(await storage!.setIfAbsentItem!("nonce", "second")).toBe(true)
    expect(await storage!.getItem("nonce")).toBe("second")
  })

  it("increments one counter atomically from several clients, with the TTL of the first increment", async () => {
    const stores = await target.stores(3)
    // Redis and Upstash round an increment TTL up to whole seconds.
    const values = await Promise.all(stores.flatMap(storage => Array.from({ length: 4 }, () => storage.incrementItem!("attempts", 1))))
    expect(values.sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
    expect(await stores[0]!.getItem("attempts")).toBe(12)

    await sleep(1300)
    expect(await stores[0]!.incrementItem!("attempts", 30)).toBe(1)
  })

  it("refuses to increment a value that is not a safe integer, and leaves it unchanged", async () => {
    const [storage] = await target.stores(1)
    await storage!.setItem("text", "hello")
    await storage!.setItem("padded", "05")
    await storage!.setItem("top", Number.MAX_SAFE_INTEGER)
    await storage!.setItem("almost", Number.MAX_SAFE_INTEGER - 1)

    if (target.name.startsWith("database")) {
      const [error, value] = await kvResult("increment", "default", () => storage!.incrementItem!("text", 30))
      expect(value).toBeUndefined()
      expect(error?.code).toBe("KV_OPERATION_FAILED")
      expect(error?.cause).toMatchObject({
        code: "KV_INVALID_COUNTER",
        fix: expect.stringContaining("Delete the key"),
        docs: "https://vitehub.dev/docs/kv/diagnostics/kv_invalid_counter",
      })
    }
    else await expect(storage!.incrementItem!("text", 30)).rejects.toThrow()
    await expect(storage!.incrementItem!("padded", 30)).rejects.toThrow()
    await expect(storage!.incrementItem!("top", 30)).rejects.toThrow()
    expect(await storage!.getItem("text")).toBe("hello")
    expect(await storage!.getItem("padded", { type: "text" })).toBe("05")
    expect(await storage!.getItem("top")).toBe(Number.MAX_SAFE_INTEGER)
    expect(await storage!.incrementItem!("almost", 30)).toBe(Number.MAX_SAFE_INTEGER)
  })

  it("restarts an expired counter at 1, also when the expired value is not an integer", async () => {
    const [storage] = await target.stores(1)
    await storage!.setItem("expired-text", "hello", { ttl: 0.5 })
    await storage!.setItem("expired-huge", "99999999999999999999", { ttl: 0.5 })
    await storage!.setItem("expired-top", Number.MAX_SAFE_INTEGER, { ttl: 0.5 })
    await sleep(800)

    expect(await storage!.incrementItem!("expired-text", 30)).toBe(1)
    expect(await storage!.incrementItem!("expired-huge", 30)).toBe(1)
    expect(await storage!.incrementItem!("expired-top", 30)).toBe(1)
    expect(await storage!.incrementItem!("expired-text", 30)).toBe(2)
  })

  it("refuses a live value beyond the bigint range without a cast error", async () => {
    const [storage] = await target.stores(1)
    await storage!.setItem("huge", "99999999999999999999")
    await storage!.setItem("negative", -5)
    await expect(storage!.incrementItem!("huge", 30)).rejects.toThrow(/stored integer|safe integer/)
    expect(await storage!.getItem("huge", { type: "text" })).toBe("99999999999999999999")
    expect(await storage!.incrementItem!("negative", 30)).toBe(-4)
  })

  it("returns a value to exactly one getAndDelete() caller", async () => {
    const stores = await target.stores(3)
    await stores[0]!.setItem("code", { user: "alice" })
    const results = await Promise.all(stores.map(storage => storage.getAndDeleteItem!("code")))
    expect(results.filter(value => value !== null)).toEqual([{ user: "alice" }])
    expect(await stores[0]!.hasItem("code")).toBe(false)
  })

  it("deletes a key only when it holds the expected value", async () => {
    const [owner, other] = await target.stores(2)
    await owner!.setItem("lock", { owner: "a" })

    expect(await other!.deleteIfEqualsItem!("lock", { owner: "b" })).toBe(false)
    expect(await owner!.getItem("lock")).toEqual({ owner: "a" })
    expect(await owner!.deleteIfEqualsItem!("lock", { owner: "a" })).toBe(true)
    expect(await owner!.hasItem("lock")).toBe(false)
    expect(await owner!.deleteIfEqualsItem!("lock", { owner: "a" })).toBe(false)
  })
})

describe.runIf(postgresUrl)("database on Postgres table setup", () => {
  it("creates the table once when several servers start at the same time", async () => {
    const admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    cleanups.push(() => admin.end())
    await admin.unsafe(`drop table if exists ${kvTable}`)

    const stores = await databaseStores(6, () => {
      const sql = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
      cleanups.push(() => sql.end())
      return sql
    })
    const results = await Promise.all(stores.map((storage, index) => storage.setIfAbsentItem!("first", `server-${index}`)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

it("fails an explicit Redis store with a missing runtime URL instead of falling back", async () => {
  vi.stubEnv("REDIS_URL", "")
  const storage = track(createHostedKVStorage(normalizeKVOptions({ driver: "redis" }, { env: {} })))
  try {
    await expect(storage.setItem("claim", "first")).rejects.toMatchObject({ code: "KV_MISSING_ENV" })
  }
  finally {
    vi.unstubAllEnvs()
  }
})

describe.runIf(redisUrl)("redis URL", () => {
  it("reads the URL from the environment variable when the store starts", async () => {
    vi.stubEnv("VITEHUB_TEST_KV_REDIS", redisUrl!)
    try {
      const storage = track(createHostedKVStorage({ store: { driver: "redis", base: `test-${randomUUID()}`, url: "env:VITEHUB_TEST_KV_REDIS" } }))
      await storage.setItem("ping", "pong")
      expect(await storage.getItem("ping")).toBe("pong")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})

describe.runIf(redisUrl)("redis namespaces with the resolved config", () => {
  // A Redis database of its own, so clearing it here cannot touch the keys of other test files.
  const url = `${redisUrl}/5`
  let redis: Redis

  beforeAll(async () => {
    redis = new Redis(url)
    await redis.flushdb()
    cleanups.push(async () => redis.disconnect())
  })

  it("keeps the default store, a named store, and foreign keys apart", async () => {
    const config = normalizeKVOptions({ stores: { default: { driver: "redis", url }, sessions: { driver: "redis", url } } }, { env: {} })
    expect(config?.stores?.default).toMatchObject({ base: "vitehub:kv:default" })
    expect(config?.stores?.sessions).toMatchObject({ base: "vitehub:kv:sessions" })
    const defaultStore = track(createHostedKVStorage(config, "default"))
    const sessions = track(createHostedKVStorage(config, "sessions"))
    // Keys of another app, such as sessions or BullMQ jobs, in the same Redis database.
    await redis.set("token", "foreign")
    await redis.set("bull:emails:1", "job")

    await defaultStore.setItem("sessions:token", "default")
    await sessions.setItem("token", "named")
    expect(await defaultStore.getItem("sessions:token")).toBe("default")
    expect(await sessions.getItem("token")).toBe("named")
    expect(await defaultStore.getKeys()).toEqual(["sessions:token"])
    expect(await sessions.getKeys()).toEqual(["token"])

    await sessions.clear()
    expect(await sessions.getKeys()).toEqual([])
    expect(await defaultStore.getItem("sessions:token")).toBe("default")
    await defaultStore.clear()
    expect(await redis.get("token")).toBe("foreign")
    expect(await redis.get("bull:emails:1")).toBe("job")
  })

  it("prefixes an explicit Redis store using its runtime URL", async () => {
    const store = normalizeKVOptions({ driver: "redis" }, { env: {} })!.store
    expect(store).toMatchObject({ base: "vitehub:kv:default", driver: "redis" })
    vi.stubEnv("REDIS_URL", url)
    try {
      const storage = track(createHostedKVStorage({ store }))
      await storage.setItem("inferred", 1)
      await storage.clear()
      expect(await redis.get("token")).toBe("foreign")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([false, true])("continues a listing across processes while deleting pages: %s", async (removePages) => {
    const config = normalizeKVOptions({ driver: "redis", base: `list-${randomUUID()}`, url }, { env: {} })
    const writer = track(createHostedKVStorage(config))
    const expected = Array.from({ length: 40 }, (_, index) => `item:${String(index).padStart(2, "0")}`)
    for (const key of expected) await writer.setItem(key, 1)

    // Each page goes to a new store with its own connection, as a request to another instance does.
    const keys: string[] = []
    let cursor: string | undefined
    do {
      const reader = track(createHostedKVStorage(config))
      const page = await reader.listKeys({ limit: 3, ...(cursor ? { cursor } : {}) })
      expect(page.keys.length).toBeLessThanOrEqual(3)
      keys.push(...page.keys)
      if (removePages) await Promise.all(page.keys.map(key => reader.removeItem(key)))
      cursor = page.cursor
    } while (cursor)
    expect([...new Set(keys)].sort()).toEqual(expected)
    if (removePages) expect(await writer.getKeys()).toEqual([])
  })
})

describe("database sweep", () => {
  interface RawTarget {
    name: string
    /** A store and a query that counts the rows of its namespace, including expired rows. */
    create(): Promise<{ storage: RuntimeStorage, rows: () => Promise<number> }>
  }

  const store = (): Extract<ResolvedKVStoreConfig, { driver: "database" }> => ({ driver: "database", database: "default", namespace: `sweep-${randomUUID()}` })
  const rawTargets: RawTarget[] = [
    {
      name: "libSQL",
      async create() {
        const client = createClient({ url: `file:${join(sqliteRoot, `${randomUUID()}.db`)}` })
        cleanups.push(async () => client.close())
        const config = store()
        const storage = track(createHostedKVStorage({ store: config }, "default", async () => ({ default: { db: { $client: client } } })))
        const rows = async () => Number((await client.execute({ sql: `select count(*) as count from ${kvTable} where namespace = ?`, args: [config.namespace] })).rows[0]!.count)
        return { rows, storage }
      },
    },
    ...postgresUrl
      ? [{
          name: "Postgres",
          async create() {
            const sql = postgres(postgresUrl, { max: 2, onnotice: () => {} })
            cleanups.push(() => sql.end())
            const config = store()
            const storage = track(createHostedKVStorage({ store: config }, "default", async () => ({ default: { db: { $client: sql } } })))
            const rows = async () => Number((await sql.unsafe(`select count(*) as count from ${kvTable} where namespace = $1`, [config.namespace]))[0]!.count)
            return { rows, storage }
          },
        }]
      : [],
  ]

  it("bounds each sweep, retries full batches on the next write, and leaves other namespaces alone", async () => {
    const client = createClient({ url: `file:${join(sqliteRoot, `${randomUUID()}.db`)}` })
    cleanups.push(async () => client.close())
    const config = store()
    const storage = track(createHostedKVStorage({ store: config }, "default", async () => ({ default: { db: { $client: client } } })))
    await storage.setItem("live", "value")
    await client.execute({
      sql: `with recursive counters(n) as (select 1 union all select n + 1 from counters where n < 2500)
        insert into ${kvTable} (namespace, "key", value, expires_at) select ?, cast(n as text), '0', 0 from counters`,
      args: [config.namespace],
    })
    await client.execute({ sql: `insert into ${kvTable} values (?, 'foreign', '0', 0)`, args: [`${config.namespace}-other`] })
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000)
    try {
      for (const remaining of [1501, 501, 1]) {
        await storage.setItem("live", "updated")
        await vi.waitFor(async () => {
          const result = await client.execute({ sql: `select count(*) as count from ${kvTable} where namespace = ?`, args: [config.namespace] })
          expect(Number(result.rows[0]!.count)).toBe(remaining)
        })
      }
      expect(Number((await client.execute(`select count(*) as count from ${kvTable} where "key" = 'foreign'`)).rows[0]!.count)).toBe(1)
    }
    finally {
      clock.mockRestore()
    }
  })

  it("keeps inferred Database claims shared with or without an unrelated REDIS_URL", async () => {
    const client = createClient({ url: `file:${join(sqliteRoot, `${randomUUID()}.db`)}` })
    cleanups.push(async () => client.close())
    const config = { store: { ...store(), inferred: true as const } }
    const databases = async () => ({ default: { db: { $client: client } } })
    vi.stubEnv("REDIS_URL", "")
    try {
      const first = track(createHostedKVStorage(config, "default", databases))
      expect(await first.setIfAbsentItem!("claim", "first", 30)).toBe(true)
      vi.stubEnv("REDIS_URL", "redis://unrelated-service:6379")
      const second = track(createHostedKVStorage(config, "default", databases))
      expect(await second.setIfAbsentItem!("claim", "second", 30)).toBe(false)
      expect(await second.getItem("claim")).toBe("first")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps writes working when the sweep fails, warns once, and tries again a minute later", async () => {
    const client = createClient({ url: `file:${join(sqliteRoot, `${randomUUID()}.db`)}` })
    cleanups.push(async () => client.close())
    let sweeps = 0
    // A client whose sweep statement fails, as on a lock timeout. Every other statement runs.
    const failingSweep = {
      execute: async (statement: { sql: string, args: (string | number | null)[] }) => {
        if (statement.sql.startsWith(`delete from ${kvTable} where (namespace`)) {
          sweeps++
          throw new Error("lock timeout")
        }
        return client.execute(statement)
      },
    }
    const storage = track(createHostedKVStorage({ store: store() }, "default", async () => ({ default: { db: { $client: failingSweep } } })))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now)
    try {
      expect(await storage.incrementItem!("window:a", 30)).toBe(1)
      expect(await storage.setIfAbsentItem!("ticket", "first", 30)).toBe(true)
      await storage.setItem("settings", "dark")
      await vi.waitFor(() => expect(sweeps).toBe(1))

      clock.mockReturnValue(now + 61_000)
      expect(await storage.incrementItem!("window:a", 30)).toBe(2)
      await vi.waitFor(() => expect(sweeps).toBe(2))
      expect(warn).toHaveBeenCalledOnce()
      expect(warn.mock.calls[0]![0]).toContain("could not delete expired rows")
    }
    finally {
      clock.mockRestore()
      warn.mockRestore()
    }
  })

  it.each(rawTargets)("deletes expired counters in an increment-only workload on $name", async (target) => {
    const { rows, storage } = await target.create()
    // One counter per client and window, as Rate Limit writes them.
    for (const client of ["a", "b", "c"]) await storage.incrementItem!(`window:1:${client}`, 0.5)
    expect(await rows()).toBe(3)
    await sleep(800)

    // The sweep runs at most once a minute, so the next increment after a minute deletes the expired counters.
    const now = Date.now()
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 61_000)
    try {
      expect(await storage.incrementItem!("window:2:a", 30)).toBe(1)
    }
    finally {
      clock.mockRestore()
    }
    await vi.waitFor(async () => expect(await rows()).toBe(1))
  })
})
