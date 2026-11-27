import { beforeEach, expect, it, vi } from "vitest"

import { normalizeKVOptions } from "../src/config.ts"
import { createKVStorage } from "../src/runtime/create-storage.ts"
import createRedisKVDriver from "../src/runtime/redis-driver.ts"

const redis = vi.hoisted(() => ({
  values: new Map<string, string>(),
  unlink: vi.fn(async (...keys: string[]) => {
    for (const key of keys) redis.values.delete(key)
    return keys.length
  }),
  scan: vi.fn(async (cursor: string, _match: string, pattern: string, _count: string, count: number): Promise<[string, string[]]> => {
    const keys = [...redis.values.keys()].filter(key => key.startsWith(pattern.slice(0, -1)))
    const offset = Number(cursor)
    const next = offset + count
    return [next < keys.length ? String(next) : "0", keys.slice(offset, next)]
  }),
}))

vi.mock("ioredis", () => ({
  Redis: class {
    get = async (key: string) => redis.values.get(key) ?? null
    set = async (key: string, value: string) => { redis.values.set(key, value); return "OK" }
    scan = redis.scan
    unlink = redis.unlink
    disconnect() {}
  },
}))

beforeEach(() => {
  redis.values.clear()
  vi.clearAllMocks()
})

it.each(["default/sessions", "default:sessions", "default\\sessions", "a/b", "a:b", "a?b", "", "%", "a%2Fb"])("isolates the generated Redis namespace for %j", async (name) => {
  const names = [...new Set(["default", "a", "a/b", "a:b", name])]
  const config = normalizeKVOptions({ stores: Object.fromEntries(names.map(store => [store, { driver: "redis" as const }])) })!
  const stores = names.map(store => {
    const options = config.stores![store]!
    if (options.driver !== "redis") throw new Error("Expected Redis")
    return createKVStorage(createRedisKVDriver({ ...options, url: "redis://localhost" }))
  })
  redis.values.set("foreign", "keep")
  for (const [index, storage] of stores.entries()) {
    await storage.setItem("sessions:token", `nested-${index}`)
    await storage.setItem("token", `value-${index}`)
  }
  for (const [index, storage] of stores.entries()) {
    expect(await storage.getItem("token")).toBe(`value-${index}`)
    expect(await storage.getItem("sessions:token")).toBe(`nested-${index}`)
    expect((await storage.getKeys()).sort()).toEqual(["sessions:token", "token"])
  }
  for (const [index, storage] of stores.entries()) {
    await storage.clear()
    expect(await storage.getKeys()).toEqual([])
    for (let remaining = index + 1; remaining < stores.length; remaining++) {
      expect(await stores[remaining]!.getItem("token")).toBe(`value-${remaining}`)
    }
  }
  expect([...redis.values]).toEqual([["foreign", "keep"]])
})

it("clears 150,000 keys with bounded deletion calls and preserves foreign keys", async () => {
  const options = { base: "large", driver: "redis" as const, url: "redis://localhost" }
  for (let index = 0; index < 150_000; index++) redis.values.set(`large:${index}`, "value")
  redis.values.set("foreign", "keep")
  const storage = createKVStorage(createRedisKVDriver(options))

  await storage.clear()

  expect([...redis.values]).toEqual([["foreign", "keep"]])
  expect(redis.unlink).toHaveBeenCalled()
  expect(redis.unlink.mock.calls.every(keys => keys.length <= 1000)).toBe(true)
})
