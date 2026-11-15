import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Redis } from "@upstash/redis"

import createUpstashKVDriver from "../src/runtime/upstash-driver.ts"
import { createKVStorage } from "../src/runtime/create-storage.ts"

const redis = {
  eval: vi.fn(async (_script: string, _keys: string[], _args: string[]) => 1),
  getdel: vi.fn(async (_key: string) => "value"),
  scan: vi.fn(async (_cursor: string, _options: { count: number; match: string }) => ["0", ["app:users:alice"]]),
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request") }))
})
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function createDriver() {
  // Keep unstorage's real asynchronous loader and inject its Redis library for offline verification.
  const options = {
    base: "app",
    driver: "upstash" as const,
    token: "test",
    url: "https://example.com",
    lib: { Redis: class {
      eval = redis.eval
      getdel = redis.getdel
      scan = redis.scan
    } },
  }
  return createUpstashKVDriver(options)
}

it("lists keys through the asynchronous unstorage Upstash client", async () => {
  await expect(createDriver().listKeys({ limit: 2, prefix: "users:" })).resolves.toEqual({ keys: ["users:alice"] })
  expect(redis.scan).toHaveBeenCalledWith("0", { count: 2, match: "app:users:*" })
})

it("gets and deletes through the asynchronous unstorage Upstash client", async () => {
  await expect(createDriver().getAndDeleteItem!("users:alice")).resolves.toBe("value")
  expect(redis.getdel).toHaveBeenCalledWith("app:users:alice")
})

it.each(["null", "123456", '"123"', '{"singleUse": true}'])("preserves stored text %s through the real Upstash client", async (value) => {
  const data = new Map<string, string>()
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    // SAFETY: The real Redis client sends a JSON command array to this offline REST fixture.
    const [command, key, text] = JSON.parse(String(init.body)) as string[]
    let result: string | null = data.get(key!) ?? null
    if (command === "set") {
      data.set(key!, text!)
      result = "OK"
    }
    else if (command === "getdel") data.delete(key!)
    else if (command !== "get") throw new Error(`Unexpected Redis command: ${command}`)
    // Match Upstash's default base64 response encoding (status replies stay plain text).
    return Response.json({ result: result === null || result === "OK" ? result : Buffer.from(result).toString("base64") })
  }))
  const options = {
    base: "app",
    driver: "upstash" as const,
    token: "test",
    url: "https://example.com",
    enableAutoPipelining: false,
    lib: { Redis },
  }
  const driver = createUpstashKVDriver(options)
  const storage = createKVStorage(driver)
  await storage.setItem("token", value)
  await expect(driver.getAndDeleteItem!("token")).resolves.toBe(value)
  await expect(driver.getAndDeleteItem!("token")).resolves.toBeNull()
  await storage.setItem("token", value)
  await expect(storage.getItem("token", { type: "text" })).resolves.toBe(value)
  await storage.dispose()
})

it("increments through the asynchronous unstorage Upstash client", async () => {
  await expect(createDriver().incrementItem!("counter", 60)).resolves.toBe(1)
  expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('INCR'"), ["app:counter"], ["60"])
})

/** An in-memory Upstash database. SCAN returns every match in one batch, as Upstash may return more than `count`. */
function createFakeUpstash() {
  const data = new Map<string, string>()
  const sets: Array<{ key: string, options: unknown }> = []
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/\\(.)|([*?])|([^\\*?])/g, (_, escaped: string | undefined, wildcard: string | undefined, plain: string | undefined) => {
    if (wildcard) return wildcard === "*" ? ".*" : "."
    return (escaped ?? plain ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  })}$`)
  class FakeRedis {
    exists = async (key: string) => Number(data.has(key))
    get = async (key: string) => data.get(key) ?? null
    mget = async (...keys: string[]) => keys.map(key => data.get(key) ?? null)
    set = async (key: string, value: string, options?: { ex?: number, nx?: boolean }) => {
      sets.push({ key, options })
      if (options?.nx && data.has(key)) return null
      data.set(key, value)
      return "OK"
    }
    unlink = async (...keys: string[]) => keys.filter(key => data.delete(key)).length
    del = async (...keys: string[]) => keys.filter(key => data.delete(key)).length
    getdel = async (key: string) => {
      const value = data.get(key) ?? null
      data.delete(key)
      return value
    }
    eval = async (_script: string, keys: string[], _args: string[]) => {
      const next = Number(data.get(keys[0]!) ?? 0) + 1
      data.set(keys[0]!, String(next))
      return next
    }
    scan = async (_cursor: string, options: { count?: number, match: string }) => {
      const match = glob(options.match)
      return ["0", [...data.keys()].filter(key => match.test(key))] as [string, string[]]
    }
  }
  const create = (store: { base?: string } = {}) => {
    // unstorage loads this Redis class instead of `@upstash/redis`, so the test stays offline.
    const options = { base: "app", driver: "upstash" as const, token: "test", url: "https://example.com", lib: { Redis: FakeRedis }, ...store }
    return createUpstashKVDriver(options)
  }
  return { create, data, sets }
}

it("keeps each store under its base, so clear() leaves other keys alone", async () => {
  const upstash = createFakeUpstash()
  upstash.data.set("foreign", "keep")
  const cache = createKVStorage(upstash.create({ base: "vitehub:kv:cache" }))
  const sessions = createKVStorage(upstash.create({ base: "vitehub:kv:sessions" }))
  await cache.setItem("user", "a")
  await sessions.setItem("user", "b")
  expect([...upstash.data.keys()].sort()).toEqual(["foreign", "vitehub:kv:cache:user", "vitehub:kv:sessions:user"])
  await expect(cache.getItem("user", { type: "text" })).resolves.toBe("a")
  await expect(cache.getKeys()).resolves.toEqual(["user"])
  await cache.clear()
  expect([...upstash.data.keys()].sort()).toEqual(["foreign", "vitehub:kv:sessions:user"])
})

it("prefixes atomic operations and lists with the store base", async () => {
  const upstash = createFakeUpstash()
  upstash.data.set("token", "foreign")
  const driver = upstash.create({ base: "app" })
  await expect(driver.setIfAbsentItem!("token", "mine")).resolves.toBe(true)
  await expect(driver.incrementItem!("count", 60)).resolves.toBe(1)
  await expect(driver.listKeys!({ limit: 10 })).resolves.toEqual({ keys: ["count", "token"] })
  await expect(driver.getAndDeleteItem!("token")).resolves.toBe("mine")
  expect(upstash.data.get("token")).toBe("foreign")
})

it("rejects a store without a base", () => {
  expect(() => createFakeUpstash().create({ base: "" })).toThrow("non-empty `base`")
})

it("sends whole seconds for a fractional TTL and rejects an invalid TTL", async () => {
  const upstash = createFakeUpstash()
  const driver = upstash.create({ base: "app" })
  await driver.setItem!("short", "v", { ttl: 0.5 })
  await driver.setItem!("plain", "v", { ttl: 0 })
  expect(upstash.sets).toEqual([
    { key: "app:short", options: { ex: 1 } },
    { key: "app:plain", options: undefined },
  ])
  await expect(Promise.resolve().then(() => driver.setItem!("bad", "v", { ttl: -1 }))).rejects.toMatchObject({ code: "KV_INVALID_TTL" })
})

it("continues a listing in another process from the cursor alone", async () => {
  const upstash = createFakeUpstash()
  for (const key of ["a", "b", "c"]) upstash.data.set(`app:${key}`, "v")
  const first = await upstash.create({ base: "app" }).listKeys!({ limit: 2 })
  expect(first.keys).toEqual(["a", "b"])
  await expect(upstash.create({ base: "app" }).listKeys!({ cursor: first.cursor, limit: 2 })).resolves.toEqual({ keys: ["c"] })
})
