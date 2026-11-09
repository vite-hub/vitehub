import { mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { checkRateLimit, createRateLimiter, peekRateLimit, resetRateLimit } from "../src/index.ts"
import { kvRateLimitDriver } from "../src/drivers/kv.ts"
import { resolveRateLimitProvider, setRateLimitRuntimeConfig } from "../src/runtime.ts"

import type { RateLimitKVStorage } from "../src/drivers/kv.ts"

afterEach(() => {
  setRateLimitRuntimeConfig({ provider: "memory" })
  vi.restoreAllMocks()
})

interface FakeKV extends RateLimitKVStorage {
  ttls: Map<string, number>
  values: Map<string, number>
}

/** A KV store with an atomic increment, as one Redis server or one Database is for every client. */
function fakeKV(): FakeKV {
  const values = new Map<string, number>()
  const ttls = new Map<string, number>()
  return {
    async del(key) {
      values.delete(key)
      return [undefined, undefined]
    },
    async get(key) {
      return [undefined, values.get(key) ?? null]
    },
    async increment(key, ttl) {
      const value = (values.get(key) ?? 0) + 1
      if (value === 1) ttls.set(key, ttl)
      values.set(key, value)
      return [undefined, value]
    },
    ttls,
    values,
  }
}

const windowStart = Date.UTC(2026, 10, 9, 12, 0, 0)

describe("kvRateLimitDriver", () => {
  it("counts a fixed window with one increment for each request, with the window as TTL", async () => {
    const kv = fakeKV()
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart + 15_000, storage: kv }), limit: 2, name: "uploads", window: "1m" })

    await expect(limiter.consume({ key: "user" })).resolves.toEqual({ allowed: true, limit: 2, remaining: 1, resetAt: windowStart + 60_000, retryAfter: undefined, used: 1, windowMs: 60_000 })
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, remaining: 0, used: 2 })
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, reason: "limited", remaining: 0, resetAt: windowStart + 60_000, retryAfter: 45, used: 3 })
    expect(limiter.capabilities).toEqual({ enforcement: "strict", rejectedAttempts: "counted", scope: "global" })
    expect([...kv.ttls]).toEqual([[`rate-limit:uploads:60000:user:${windowStart}`, 60]])
  })

  it("starts a new counter in the next window", async () => {
    const kv = fakeKV()
    let now = windowStart + 59_000
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ now: () => now, storage: kv }), limit: 1, name: "uploads", window: "1m" })

    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, retryAfter: 1 })
    now = windowStart + 60_000
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, resetAt: windowStart + 120_000 })
  })

  it("keeps keys with separators apart", async () => {
    const kv = fakeKV()
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart, storage: kv }), limit: 1, name: "a:b", window: "1m" })
    const other = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart, storage: kv }), limit: 1, name: "a", window: "1m" })

    await expect(limiter.consume({ key: "::1" })).resolves.toMatchObject({ allowed: true })
    await expect(other.consume({ key: "b:::1" })).resolves.toMatchObject({ allowed: true })
    expect([...kv.values.keys()]).toEqual([`rate-limit:a%3Ab:60000:%3A%3A1:${windowStart}`, `rate-limit:a:60000:b%3A%3A%3A1:${windowStart}`])
  })

  it("encodes dots, because KV rejects a `.` or `..` key segment", async () => {
    const kv = fakeKV()
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart, storage: kv }), limit: 1, name: "api.upload", window: "1m" })
    await limiter.consume({ key: ".." })
    expect([...kv.values.keys()]).toEqual([`rate-limit:api%2Eupload:60000:%2E%2E:${windowStart}`])
  })

  it("keeps windows of different lengths apart, each with its own TTL", async () => {
    const kv = fakeKV()
    // windowStart is a full hour, so a minute window and an hour window start together.
    const minute = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart, storage: kv }), limit: 1, window: "1m" })
    const hour = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart, storage: kv }), limit: 1, window: "1h" })

    await expect(minute.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
    await expect(hour.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
    expect([...kv.ttls]).toEqual([[`rate-limit:default:60000:user:${windowStart}`, 60], [`rate-limit:default:3600000:user:${windowStart}`, 3600]])
    await hour.reset({ key: "user" })
    await expect(minute.peek({ key: "user" })).resolves.toMatchObject({ used: 1 })
  })

  it("reads and deletes the counter of the current window", async () => {
    const kv = fakeKV()
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ now: () => windowStart, storage: kv }), limit: 5, name: "uploads", window: "1m" })

    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ remaining: 5, status: "known", used: 0 })
    await limiter.consume({ key: "user" })
    await limiter.consume({ key: "user" })
    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ remaining: 3, resetAt: windowStart + 60_000, status: "known", used: 2 })
    await expect(limiter.reset({ key: "user" })).resolves.toEqual({ status: "reset" })
    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ status: "known", used: 0 })
  })

  it.each([["deny", false], ["allow", true]] as const)("follows failure: %s when KV fails", async (failure, allowed) => {
    const cause = new Error("connection refused")
    const kv: RateLimitKVStorage = { ...fakeKV(), increment: async () => [cause, undefined] }
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: kv }), failure, limit: 1, window: "1m" })

    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed, cause, reason: "unavailable" })
  })

  it("requires a KV store with increment, get, and del", () => {
    expect(() => kvRateLimitDriver({ storage: { increment: async () => [undefined, 1] } as never })).toThrow(expect.objectContaining({ code: "RATE_LIMIT_R0046" }))
  })
})

describe("kv provider at runtime", () => {
  const event = () => mockEvent("https://example.com/upload")

  it("counts in KV when the store uses a shared driver", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    const kv = fakeKV()
    setRateLimitRuntimeConfig({ provider: "kv" }, { driver: async () => "redis", storage: kv, store: "default" })

    await expect(resolveRateLimitProvider()).resolves.toBe("kv")
    expect(info).toHaveBeenCalledWith(expect.stringContaining("KV store \"default\" (redis)"))
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject({ allowed: true })
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject({ allowed: false })
    expect([...kv.values.values()]).toEqual([2])
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ counters: [{ used: 2 }], provider: "kv", scope: "global", status: "known" })
    await expect(resetRateLimit("uploads", "user")).resolves.toMatchObject({ scope: "global", status: "reset" })
    expect(info).toHaveBeenCalledTimes(1)
  })

  it("counts in memory with a warning when the KV store cannot share counts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const kv = fakeKV()
    setRateLimitRuntimeConfig({ provider: "kv" }, { driver: async () => "fs-lite", storage: kv, store: "default" })

    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject({ allowed: true })
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject({ allowed: false })
    expect(kv.values.size).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("uses fs-lite, which has no shared atomic increment"))
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ provider: "memory", scope: "process" })
  })

  it("fails without a KV store, and tries the KV driver again after a failure", async () => {
    setRateLimitRuntimeConfig({ provider: "kv" })
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).rejects.toMatchObject({ code: "RATE_LIMIT_R0047" })

    vi.spyOn(console, "info").mockImplementation(() => {})
    const driver = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("unknown store")).mockResolvedValue("database")
    setRateLimitRuntimeConfig({ provider: "kv" }, { driver, storage: fakeKV(), store: "default" })
    await expect(resolveRateLimitProvider()).rejects.toThrow("unknown store")
    await expect(resolveRateLimitProvider()).resolves.toBe("kv")
    expect(driver).toHaveBeenCalledTimes(2)
  })

  it("does not know the window of a kv counter that this process never used", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    setRateLimitRuntimeConfig({ provider: "kv" }, { driver: async () => "redis", storage: fakeKV(), store: "default" })

    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ status: "unused" })
    await expect(resetRateLimit("uploads", "user")).resolves.toMatchObject({ status: "unsupported" })
  })
})
