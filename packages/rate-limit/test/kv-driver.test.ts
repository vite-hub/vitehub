import { mockEvent } from "h3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { checkRateLimit, createRateLimiter, peekRateLimit, resetRateLimit } from "../src/index.ts"
import { kvRateLimitDriver } from "../src/drivers/kv.ts"
import { resolveRateLimitProvider, setRateLimitRuntimeConfig } from "../src/runtime.ts"

import type { RateLimitKVStorage } from "../src/drivers/kv.ts"

afterEach(() => {
  setRateLimitRuntimeConfig({ provider: "memory" })
  vi.useRealTimers()
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
    async delete(key) {
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

  it.each([["deny", false], ["allow", true]] as const)("follows failure: %s after one second when KV stalls", async (failure, allowed) => {
    vi.useFakeTimers()
    const kv: RateLimitKVStorage = { ...fakeKV(), increment: () => new Promise(() => {}) }
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: kv }), failure, limit: 1, window: "1m" })
    const result = vi.fn()
    void limiter.consume({ key: "user" }).then(result)

    await vi.advanceTimersByTimeAsync(999)
    expect(result).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ allowed, cause: expect.any(Error), reason: "unavailable" }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["peek", "reset"] as const)("bounds a stalled KV %s operation", async (operation) => {
    vi.useFakeTimers()
    const kv: RateLimitKVStorage = { ...fakeKV(), delete: () => new Promise(() => {}), get: () => new Promise(() => {}) }
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: kv }), limit: 1, window: "1m" })
    const result = vi.fn()
    void limiter[operation]({ key: "user" }).then(result)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ cause: expect.any(Error), status: "unavailable" }))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("clears deadlines after successful operations and preserves thrown errors", async () => {
    vi.useFakeTimers()
    const kv = fakeKV()
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: kv }), limit: 1, window: "1m" })
    await limiter.consume({ key: "user" })
    await limiter.peek({ key: "user" })
    await limiter.reset({ key: "user" })
    expect(vi.getTimerCount()).toBe(0)

    const cause = new Error("invalid KV configuration")
    kv.increment = async () => { throw cause }
    await expect(limiter.consume({ key: "user" })).rejects.toBe(cause)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("handles a KV rejection after the deadline", async () => {
    vi.useFakeTimers()
    const cause = new Error("connection timed out")
    const kv: RateLimitKVStorage = { ...fakeKV(), increment: () => new Promise((_, reject) => setTimeout(() => reject(cause), 2_000)) }
    const limiter = createRateLimiter({ driver: kvRateLimitDriver({ storage: kv }), limit: 1, window: "1m" })
    const result = vi.fn()
    void limiter.consume({ key: "user" }).then(result)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(result).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allowed: false, reason: "unavailable" }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(result).toHaveBeenCalledTimes(1)
  })

  it("requires a KV store with increment, get, and delete", () => {
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
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject([undefined, { allowed: true }])
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject([undefined, { allowed: false }])
    expect([...kv.values.values()]).toEqual([2])
    await expect(peekRateLimit("uploads", "user")).resolves.toMatchObject({ counters: [{ used: 2 }], provider: "kv", scope: "global", status: "known" })
    await expect(resetRateLimit("uploads", "user")).resolves.toMatchObject({ scope: "global", status: "reset" })
    expect(info).toHaveBeenCalledTimes(1)
  })

  it("counts in memory with a warning when the KV store cannot share counts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const kv = fakeKV()
    setRateLimitRuntimeConfig({ provider: "kv" }, { driver: async () => "fs-lite", storage: kv, store: "default" })

    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject([undefined, { allowed: true }])
    await expect(checkRateLimit(event(), "uploads", { key: "user", limit: 1, window: "1m" })).resolves.toMatchObject([undefined, { allowed: false }])
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
