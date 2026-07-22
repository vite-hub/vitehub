import { describe, expect, it, vi } from "vitest"

import { createRateLimiter } from "../src/index.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"

import type { RateLimitDriverCapabilities } from "../src/index.ts"

const strictCapabilities = {
  enforcement: "strict",
  rejectedAttempts: "not-counted",
  scope: "global",
} satisfies RateLimitDriverCapabilities

describe("Rate Limit core", () => {
  it("validates and normalizes policies", () => {
    const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: "1m" })
    expect(limiter.policy).toEqual({
      enforcement: "best-effort",
      failure: "deny",
      limit: 10,
      window: "1m",
      windowMs: 60_000,
    })
    expect(() => createRateLimiter({ driver: memoryRateLimitDriver(), limit: 0, window: "1m" })).toThrow("positive integer")
    expect(() => createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window: "soon" as never })).toThrow("must use a duration")
  })

  it("consumes a fixed window atomically in memory", async () => {
    let now = 60_001
    const driver = memoryRateLimitDriver({ now: () => now })
    const limiter = createRateLimiter({ driver, enforcement: "strict", limit: 2, window: "1m" })

    await expect(Promise.all([
      limiter.consume({ key: "user-1" }),
      limiter.consume({ key: "user-1" }),
      limiter.consume({ key: "user-1" }),
    ])).resolves.toEqual([
      expect.objectContaining({ allowed: true, remaining: 1, used: 1 }),
      expect.objectContaining({ allowed: true, remaining: 0, used: 2 }),
      expect.objectContaining({ allowed: false, reason: "limited", remaining: 0, used: 2 }),
    ])

    now = 120_001
    await expect(limiter.consume({ key: "user-1" })).resolves.toMatchObject({ allowed: true, used: 1 })
  })

  it("isolates named limiters that share a memory driver", async () => {
    const driver = memoryRateLimitDriver({ now: () => 1 })
    const first = createRateLimiter({ driver, limit: 1, name: "first", window: "1m" })
    const second = createRateLimiter({ driver, limit: 1, name: "second", window: "1m" })

    await expect(first.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
    await expect(first.consume({ key: "user" })).resolves.toMatchObject({ allowed: false })
    await expect(second.consume({ key: "user" })).resolves.toMatchObject({ allowed: true })
  })

  it("fails closed at capacity without evicting live counters", async () => {
    const driver = memoryRateLimitDriver({ maxEntries: 1, now: () => 1 })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.consume({ key: "A" })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(limiter.consume({ key: "B" })).rejects.toThrow("reached maxEntries")
    await expect(limiter.consume({ key: "A" })).resolves.toMatchObject({ allowed: false, used: 1 })
    expect(driver.size()).toBe(1)
  })

  it("validates driver guarantees before consumption", () => {
    expect(() => createRateLimiter({
      driver: { capabilities: { ...strictCapabilities, enforcement: "best-effort" }, consume: () => [null, { allowed: true }], name: "edge" },
      enforcement: "strict",
      limit: 1,
      window: "1m",
    })).toThrow("requires strict enforcement")

    expect(() => createRateLimiter({
      driver: { capabilities: { ...strictCapabilities, windows: [10_000] }, consume: () => [null, { allowed: true }], name: "narrow" },
      limit: 1,
      window: "1m",
    })).toThrow("does not support")

    expect(() => createRateLimiter({
      driver: { capabilities: {} as never, consume: () => [null, { allowed: true }], name: "opaque" },
      limit: 1,
      window: "1m",
    })).toThrow("valid enforcement")
  })

  it("exposes resolved driver capabilities", () => {
    const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window: "1m" })
    expect(limiter.capabilities).toEqual({
      enforcement: "strict",
      rejectedAttempts: "not-counted",
      scope: "process",
    })
  })

  it("applies explicit failure policy", async () => {
    const cause = new Error("offline")
    const consume = vi.fn((): import("../src/index.ts").RateLimitDriverOutcome => [cause, undefined])
    const driver = { capabilities: strictCapabilities, consume, name: "offline" }
    const allow = createRateLimiter({ driver, failure: "allow", limit: 1, window: "1m" })
    const deny = createRateLimiter({ driver, failure: "deny", limit: 1, window: "1m" })

    await expect(allow.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, cause, reason: "unavailable" })
    await expect(deny.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, cause, reason: "unavailable" })
  })

  it("does not classify arbitrary driver defects as unavailability", async () => {
    const defect = new Error("driver defect")
    const driver = { capabilities: strictCapabilities, consume: () => { throw defect }, name: "defect" }
    const allow = createRateLimiter({ driver, failure: "allow", limit: 1, window: "1m" })
    const deny = createRateLimiter({ driver, failure: "deny", limit: 1, window: "1m" })

    await expect(allow.consume({ key: "user" })).rejects.toBe(defect)
    await expect(deny.consume({ key: "user" })).rejects.toBe(defect)
  })
})
