import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeEach, describe, expect, it, vi } from "vitest"

import { getItemsOneByOne, kvBatchConcurrency } from "../src/runtime/batch.ts"
import createCloudflareDriver from "../src/runtime/cloudflare-kv.ts"
import { createKVStorage } from "../src/runtime/create-storage.ts"
import createDatabaseKVDriver from "../src/runtime/database.ts"
import { createHostedKVStorage } from "../src/runtime/hosted-storage.ts"
import createRedisKVDriver from "../src/runtime/redis-driver.ts"
import createUpstashKVDriver from "../src/runtime/upstash-driver.ts"

const redis = vi.hoisted(() => ({
  values: new Map<string, string>(),
  calls: { exec: 0, get: 0, mget: 0, set: 0 },
}))

vi.mock("ioredis", () => ({
  Redis: class {
    async get(key: string) { redis.calls.get++; return redis.values.get(key) ?? null }
    async mget(...keys: string[]) { redis.calls.mget++; return keys.map(key => redis.values.get(key) ?? null) }
    async set(key: string, value: string) { redis.calls.set++; redis.values.set(key, value); return "OK" }
    pipeline() {
      const commands: Array<[string, string, ...unknown[]]> = []
      const pipeline = {
        set(key: string, value: string, ...rest: unknown[]) { commands.push([key, value, ...rest]); return pipeline },
        async exec() {
          redis.calls.exec++
          for (const [key, value] of commands) redis.values.set(key, value)
          return commands.map(() => [null, "OK"])
        },
      }
      return pipeline
    }
    disconnect() {}
  },
}))

beforeEach(() => {
  redis.values.clear()
  redis.calls = { exec: 0, get: 0, mget: 0, set: 0 }
})

describe("kv.getMany() and kv.setMany() on fs-lite", () => {
  it("returns values in key order, null for missing keys, and lets the last entry of a key win", async () => {
    const base = await mkdtemp(join(tmpdir(), "vitehub-kv-many-"))
    const storage = createHostedKVStorage({ store: { base, driver: "fs-lite" } })
    try {
      await storage.setMany([
        { key: "a", value: { n: 1 } },
        { key: "b", value: "first" },
        { key: "b", value: "last" },
        { key: "n", value: 123 },
      ])
      await expect(storage.getMany(["b", "missing", "a", "b", "n"])).resolves.toEqual(["last", null, { n: 1 }, "last", 123])
      await expect(storage.getMany(["n", "a"], { type: "text" })).resolves.toEqual(["123", "{\"n\":1}"])
      const [bytes] = await storage.getMany<Uint8Array>(["b"], { type: "bytes" })
      expect(new TextDecoder().decode(bytes!)).toBe("last")
      await storage.setMany([{ key: "a", value: undefined }])
      await expect(storage.getMany(["a"])).resolves.toEqual([null])
      await expect(storage.getMany([])).resolves.toEqual([])
      await storage.setMany([])
    }
    finally {
      await storage.dispose()
      await rm(base, { force: true, recursive: true })
    }
  })
})

it("runs at most 16 single-key reads at once on a store without a batch read", async () => {
  let running = 0
  let peak = 0
  const getItemsOf = getItemsOneByOne({
    getKeys: () => [],
    hasItem: () => false,
    async getItem(key) {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 1))
      running--
      return `value:${key}`
    },
  })
  const items = Array.from({ length: 100 }, (_, index) => ({ key: `k${index}` }))
  const result = await getItemsOf(items)
  expect(result.map(item => item.value)).toEqual(items.map(item => `value:${item.key}`))
  expect(peak).toBe(kvBatchConcurrency)
})

describe("Redis", () => {
  it("reads with MGET, 1000 keys per call, and writes with one pipeline", async () => {
    const storage = createKVStorage(createRedisKVDriver({ base: "app", driver: "redis", url: "redis://localhost" }))
    const entries = Array.from({ length: 2500 }, (_, index) => ({ key: `k${index}`, value: index }))
    await storage.setMany(entries, { ttl: 60 })
    expect(redis.calls).toMatchObject({ exec: 1, set: 0 })
    const values = await storage.getMany(entries.map(entry => entry.key))
    expect(values).toEqual(entries.map(entry => entry.value))
    expect(redis.calls).toMatchObject({ get: 0, mget: 3 })
  })
})

describe("Upstash", () => {
  it("reads with one MGET", async () => {
    const mget = vi.fn(async (...keys: string[]) => keys.map(key => key === "a" ? "1" : null))
    const get = vi.fn()
    const storage = createKVStorage(createUpstashKVDriver({
      driver: "upstash",
      token: "test",
      url: "https://example.com",
      // @ts-expect-error The test injects the Upstash library, which the store config does not type.
      lib: { Redis: class { mget = mget; get = get } },
    }))
    await expect(storage.getMany(["a", "b"])).resolves.toEqual([1, null])
    expect(mget).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
  })
})

describe("database", () => {
  it("reads 200 keys per query and writes 200 entries per statement", async () => {
    const rows = new Map<string, string>()
    const statements: string[] = []
    const query = vi.fn(async (sql: string, params: (string | number | null)[]): Promise<Record<string, unknown>[]> => {
      statements.push(sql.trim().split(/\s+/)[0]!)
      if (sql.startsWith("select 1 from")) return []
      if (sql.startsWith("insert")) {
        for (let index = 0; index < params.length; index += 3) rows.set(String(params[index + 1]), String(params[index + 2]))
        return []
      }
      if (sql.startsWith("select \"key\", value")) {
        return params.slice(1).flatMap(key => rows.has(String(key)) ? [{ key, value: rows.get(String(key)) }] : [])
      }
      return []
    })
    const storage = createKVStorage(createDatabaseKVDriver({ driver: "database", database: "default", namespace: "test" }, async () => ({ dialect: "sqlite", query })))
    const entries = Array.from({ length: 450 }, (_, index) => ({ key: `k${index}`, value: `v${index}` }))
    await storage.setMany(entries)
    expect(statements.filter(statement => statement === "insert")).toHaveLength(3)
    const keys = [...entries.map(entry => entry.key), "missing"]
    await expect(storage.getMany(keys)).resolves.toEqual([...entries.map(entry => entry.value), null])
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("select \"key\", value"))).toHaveLength(3)
  })
})

describe("Cloudflare KV", () => {
  function createBinding() {
    const values = new Map<string, string>()
    const calls = { bulkGet: 0, get: 0, put: 0 }
    const binding = {
      async get(key: string | string[]) {
        if (Array.isArray(key)) {
          calls.bulkGet++
          if (key.length > 100) throw new Error("Too many keys")
          return new Map(key.map(name => [name, values.get(name) ?? null]))
        }
        calls.get++
        return values.get(key) ?? null
      },
      async put(key: string, value: string) { calls.put++; values.set(key, value) },
      async delete(key: string) { values.delete(key) },
      async list() { return { keys: [], list_complete: true } },
    }
    return { binding, calls, values }
  }

  it("reads 100 keys per bulk get", async () => {
    const { binding, calls, values } = createBinding()
    for (let index = 0; index < 250; index++) values.set(`k${index}`, String(index))
    const storage = createKVStorage(createCloudflareDriver({ binding }))
    const keys = Array.from({ length: 251 }, (_, index) => `k${index}`)
    await expect(storage.getMany(keys)).resolves.toEqual([...keys.slice(0, 250).map((_, index) => index), null])
    expect(calls).toMatchObject({ bulkGet: 3, get: 0 })
  })

  it("checks every key and entry before it calls the binding", async () => {
    const { binding, calls } = createBinding()
    const storage = createKVStorage(createCloudflareDriver({ binding }))
    await expect(storage.getMany(["a", "k".repeat(513)])).rejects.toMatchObject({ code: "KV_KEY_TOO_LONG" })
    await expect(storage.setMany([{ key: "a", value: "1" }, { key: "b", value: "x".repeat(25 * 1024 * 1024 + 1) }])).rejects.toMatchObject({ code: "KV_VALUE_TOO_LARGE" })
    expect(calls).toEqual({ bulkGet: 0, get: 0, put: 0 })
    await storage.setMany([{ key: "a", value: "1" }, { key: "b", value: "2" }])
    expect(calls.put).toBe(2)
  })
})
