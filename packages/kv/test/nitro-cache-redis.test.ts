import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Redis } from "ioredis"
import { createStorage } from "unstorage"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const redisUrl = process.env.VITEHUB_TEST_REDIS_URL
const state = vi.hoisted(() => ({ base: "" }))

// An explicit Redis store reads only its connection URL at runtime.
vi.mock("#vitehub/kv/config", () => ({
  hosting: "node-server",
  get kv() {
    return { store: { driver: "redis", base: "vitehub:kv:default", url: "env:REDIS_URL" } }
  },
  loadDatabases: undefined,
}))
// The cache driver imports the package entry, so both share the store resolved from the mocked config.
vi.mock("@vite-hub/kv", async () => await import("../src/index.ts"))
vi.mock("@vite-hub/kv/runtime/redis-driver", async () => await import("../src/runtime/redis-driver.ts"))

describe.runIf(redisUrl)("Nitro cache on an explicit Redis store with a runtime URL", () => {
  const prefix = `nitro-cache-${randomUUID()}`
  let redis: Redis

  beforeAll(async () => {
    state.base = await mkdtemp(join(tmpdir(), "vitehub-kv-inferred-"))
    vi.stubEnv("REDIS_URL", redisUrl!)
    redis = new Redis(redisUrl!)
  })
  afterAll(async () => {
    const { disposeKVStores } = await import("../src/index.ts")
    await disposeKVStores()
    vi.unstubAllEnvs()
    redis.disconnect()
    await rm(state.base, { force: true, recursive: true })
  })

  it("stores KV keys and cache entries in Redis, not in files", async () => {
    const { kv } = await import("../src/index.ts")
    const { default: createKVCacheDriver } = await import("../src/runtime/nitro-cache.ts")
    const storage = createStorage()
    storage.mount("cache", createKVCacheDriver({ base: prefix }))

    expect(await kv.set(`${prefix}-settings`, { theme: "dark" })).toEqual([undefined, undefined])
    // Nitro writes each cached function result with its `maxAge` as the TTL.
    await storage.setItem("cache:nitro:functions:stars:repo.json", { value: 42, expires: Date.now() + 5000 }, { ttl: 5 })

    expect(await storage.getItem("cache:nitro:functions:stars:repo.json")).toMatchObject({ value: 42 })
    expect(await storage.getKeys("cache")).toEqual(["cache:nitro:functions:stars:repo.json"])
    // The store keeps its keys under its own Redis prefix.
    const redisKey = `vitehub:kv:default:${prefix}:nitro:functions:stars:repo.json`
    expect(await redis.get(redisKey)).toContain("\"value\":42")
    const ttl = await redis.pttl(redisKey)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(5000)
    expect(await readdir(state.base)).toEqual([])

    // A second server process shares the entry through Redis.
    const { createHostedKVStorage } = await import("../src/runtime/hosted-storage.ts")
    const other = createHostedKVStorage({ store: { driver: "redis", base: "vitehub:kv:default", url: "env:REDIS_URL" } })
    expect(await other.getItem(`${prefix}:nitro:functions:stars:repo.json`)).toMatchObject({ value: 42 })
    await other.dispose()

    await storage.clear("cache")
    expect(await redis.exists(redisKey)).toBe(0)
    expect(await kv.get(`${prefix}-settings`)).toEqual([undefined, { theme: "dark" }])
    expect(await kv.deleteIfEquals(`${prefix}-settings`, { theme: "dark" })).toEqual([undefined, true])
  })
})
