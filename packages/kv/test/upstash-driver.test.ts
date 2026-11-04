import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { Redis } from "@upstash/redis"

import createUpstashKVDriver from "../src/runtime/upstash-driver.ts"
import { createKVStorage } from "../src/runtime/create-storage.ts"

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
  expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('INCR'"), ["counter"], ["60"])
})
