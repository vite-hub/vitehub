import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createClient } from "@libsql/client"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { kvTable } from "../src/runtime/database.ts"
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

/** A Database as `@vite-hub/database/drizzle` exports it: the KV driver reads only `$client`. */
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
