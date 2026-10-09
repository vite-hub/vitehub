import { afterEach, beforeEach, expect, it, vi } from "vitest"

import createUpstashKVDriver from "../src/runtime/upstash-driver.ts"

const redis = {
  eval: vi.fn(async (_script: string, _keys: string[], _args: string[]) => 1),
  getdel: vi.fn(async (_key: string) => "value"),
  scan: vi.fn(async (_cursor: string, _options: { count: number; match: string }) => ["0", ["users:alice"]]),
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
  expect(redis.scan).toHaveBeenCalledWith("0", { count: 2, match: "users:*" })
})

it("gets and deletes through the asynchronous unstorage Upstash client", async () => {
  await expect(createDriver().getAndDeleteItem!("users:alice")).resolves.toBe("value")
  expect(redis.getdel).toHaveBeenCalledWith("users:alice")
})

it("increments through the asynchronous unstorage Upstash client", async () => {
  await expect(createDriver().incrementItem!("counter", 60)).resolves.toBe(1)
  expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('INCR'"), ["counter"], ["60"])
})
