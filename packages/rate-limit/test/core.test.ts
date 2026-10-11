import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"

import { createRateLimiter } from "../src/index.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"

import type { RateLimitDriver, RateLimitDriverCapabilities } from "../src/index.ts"

const strictCapabilities = {
  enforcement: "strict",
  rejectedAttempts: "not-counted",
  scope: "global",
} satisfies RateLimitDriverCapabilities

describe("Rate Limit core", () => {
  it.each(["allow", "deny"] as const)("rejects malformed consume tuples before applying failure %s", async (failure) => {
    const invalid = [
      ["malformed-error", undefined],
      [],
      [undefined, { allowed: true }],
      [false, { allowed: true }],
      [null, { allowed: true }, "extra"],
      [new Error("offline"), { allowed: true }],
      [new Error("offline")],
      [{ name: "Error", message: "spoofed", [Symbol.toStringTag]: "Error" }, undefined],
    ]
    for (const outcome of invalid) {
      const driver = memoryRateLimitDriver()
      Object.assign(driver, { consume: () => outcome })
      const limiter = createRateLimiter({ driver, failure, limit: 1, window: "1m" })
      await expect(limiter.consume({ key: "user" })).rejects.toThrow("must return [null, value] or [Error, undefined]")
    }
  })

  it("accepts consume errors from another JavaScript realm", async () => {
    const cause: unknown = runInNewContext("new Error('cross-realm offline')")
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { consume: () => [cause, undefined] })
    const limiter = createRateLimiter({ driver, failure: "allow", limit: 1, window: "1m" })
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, cause, reason: "unavailable" })
  })

  it.each([[], [new Error("offline")], [undefined, { used: 1 }], [null, { used: 1 }, "extra"], [new Error("offline"), { used: 1 }]].map(outcome => ({ outcome })))("rejects malformed custom peek outcomes: %j", async ({ outcome }) => {
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { peek: () => outcome })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.peek({ key: "user" })).rejects.toThrow("must return [null, value] or [Error, undefined]")
  })

  it.each([[], [undefined], [null, "extra"], ["error"]].map(outcome => ({ outcome })))("rejects malformed custom reset outcomes: %j", async ({ outcome }) => {
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { reset: () => outcome })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.reset({ key: "user" })).rejects.toThrow("must return [null] or [Error]")
  })

  it("rejects spoofed Error brands for peek and reset", async () => {
    const cause = { name: "Error", message: "spoofed", [Symbol.toStringTag]: "Error" }
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { peek: () => [cause, undefined], reset: () => [cause] })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.peek({ key: "user" })).rejects.toThrow("must return [null, value] or [Error, undefined]")
    await expect(limiter.reset({ key: "user" })).rejects.toThrow("must return [null] or [Error]")
  })

  it("validates tagged and foreign Errors without native Error.isError", async () => {
    const tagged = Object.assign(new Error("offline"), { [Symbol.toStringTag]: "ProviderError" })
    const foreign: unknown = runInNewContext("new Error('cross-realm offline')")
    const spoof = { name: "Error", message: "spoofed", [Symbol.toStringTag]: "Error" }
    const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
    Object.defineProperty(Error, "isError", { configurable: true, value: undefined })
    try {
      const driver = memoryRateLimitDriver()
      const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
      for (const cause of [tagged, foreign]) {
        Object.assign(driver, { peek: () => [cause, undefined], reset: () => [cause] })
        await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ cause, status: "unavailable" })
        await expect(limiter.reset({ key: "user" })).resolves.toEqual({ cause, status: "unavailable" })
      }
      Object.assign(driver, { peek: () => [spoof, undefined], reset: () => [spoof] })
      await expect(limiter.peek({ key: "user" })).rejects.toThrow("must return [null, value] or [Error, undefined]")
      await expect(limiter.reset({ key: "user" })).rejects.toThrow("must return [null] or [Error]")
    }
    finally {
      if (descriptor) Object.defineProperty(Error, "isError", descriptor)
      else Reflect.deleteProperty(Error, "isError")
    }
  })

  it("accepts genuine Errors with a custom display tag", async () => {
    const cause = Object.assign(new Error("offline"), { [Symbol.toStringTag]: "ProviderError" })
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { peek: () => [cause, undefined], reset: () => [cause] })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ cause, status: "unavailable" })
    await expect(limiter.reset({ key: "user" })).resolves.toEqual({ cause, status: "unavailable" })
  })

  it("accepts driver peek errors from another JavaScript realm", async () => {
    const cause: unknown = runInNewContext("new Error('cross-realm offline')")
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { peek: () => [cause, undefined] })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ cause, status: "unavailable" })
  })

  it("accepts driver reset errors from another JavaScript realm", async () => {
    const cause: unknown = runInNewContext("new Error('cross-realm offline')")
    const driver = memoryRateLimitDriver()
    Object.assign(driver, { reset: () => [cause] })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.reset({ key: "user" })).resolves.toEqual({ cause, status: "unavailable" })
  })

  it("accepts reset success and driver errors", async () => {
    const driver = memoryRateLimitDriver()
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.reset({ key: "user" })).resolves.toEqual({ status: "reset" })
    const cause = new Error("offline")
    Object.assign(driver, { reset: () => [cause] })
    await expect(limiter.reset({ key: "user" })).resolves.toEqual({ cause, status: "unavailable" })
  })

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

  it.each(["s", "m", "d"])("rejects %s windows that overflow during conversion", (unit) => {
    const options = { driver: memoryRateLimitDriver(), limit: 1, window: "1m" as const }
    Object.assign(options, { window: `${"1" + "0".repeat(307)}${unit}` })

    expect(() => createRateLimiter(options)).toThrow("finite")
  })

  it.each(["8640000000000001ms", "8640000000001s", "144000000001m", "2400000001h", "100000001d"] as const)("rejects %s windows outside the timestamp range", (window) => {
    expect(() => createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window })).toThrow("8640000000000000")
  })

  it.each(["8640000000000000.1ms", "8640000000000.0001s", "144000000000.000001m", "2400000000.00000001h", "100000000.000000001d"] as const)("rejects fractional overflow in %s before decimal rounding", (window) => {
    expect(() => createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window })).toThrow("8640000000000000")
  })

  it.each(["8640000000000000ms", "100000000d", "8640000000000000.000ms", "100000000.000000000d"] as const)("keeps %s counter reset timestamps inspectable", async (window) => {
    const limiter = createRateLimiter({ driver: memoryRateLimitDriver({ now: () => 60_001 }), limit: 1, window })
    const consumed = await limiter.consume({ key: "user" })
    expect(consumed.resetAt).toBe(8.64e15)
    const counter = await limiter.peek({ key: "user" })
    expect(counter).toMatchObject({ resetAt: 8.64e15, status: "known", used: 1 })
    expect(new Date(consumed.resetAt!).toISOString()).toBe("+275760-09-13T00:00:00.000Z")
  })

  it.each([
    { timestamp: 6e15, window: "5000000000000000ms" },
    { timestamp: 8.64e15, window: "1ms" },
  ] as const)("rejects an unrepresentable fixed-window end at $timestamp without storing a counter", async ({ timestamp, window }) => {
    const driver = memoryRateLimitDriver({ now: () => timestamp })
    const limiter = createRateLimiter({ driver, failure: "allow", limit: 1, window })

    await expect(limiter.consume({ key: "user" })).rejects.toMatchObject({ code: "RATE_LIMIT_R0045" })
    expect(driver.size()).toBe(0)
    const counter = await limiter.peek({ key: "user" })
    expect(counter).toMatchObject({ status: "known", used: 0 })
    expect(counter).not.toHaveProperty("resetAt")
  })

  it.each(["consume", "peek"] as const)("rejects custom %s timestamps outside the supported range", async (operation) => {
    for (const resetAt of [8.64e15 + 1, 1e16]) {
      const driver: RateLimitDriver = {
        capabilities: strictCapabilities,
        consume: () => [null, { allowed: true, resetAt }],
        name: "custom",
        peek: () => [null, { resetAt, used: 1 }],
      }
      const limiter = createRateLimiter({ driver, failure: "allow", limit: 2, window: "1m" })
      await expect(limiter[operation]({ key: "user" })).rejects.toThrow("8640000000000000")
    }
  })

  it("accepts the exact custom reset timestamp boundary for consume and peek", async () => {
    const driver: RateLimitDriver = {
      capabilities: strictCapabilities,
      consume: () => [null, { allowed: true, resetAt: 8.64e15 }],
      name: "custom",
      peek: () => [null, { resetAt: 8.64e15, used: 1 }],
    }
    const limiter = createRateLimiter({ driver, limit: 2, window: "1m" })

    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ resetAt: 8.64e15 })
    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ resetAt: 8.64e15, status: "known" })
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

  it("isolates consumption when names and keys contain null characters", async () => {
    const driver = memoryRateLimitDriver({ now: () => 1 })
    const first = createRateLimiter({ driver, limit: 1, name: "tenant", window: "1m" })
    const second = createRateLimiter({ driver, limit: 1, name: "tenant\0admin", window: "1m" })

    await expect(first.consume({ key: "admin\0user" })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(second.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(first.consume({ key: "admin\0user" })).resolves.toMatchObject({ allowed: false, used: 1 })
    await expect(second.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, used: 1 })
    expect(driver.size()).toBe(2)
  })

  it("isolates peek results when names and keys contain null characters", async () => {
    const driver = memoryRateLimitDriver({ now: () => 1 })
    const first = createRateLimiter({ driver, limit: 1, name: "tenant", window: "1m" })
    const second = createRateLimiter({ driver, limit: 1, name: "tenant\0admin", window: "1m" })

    await first.consume({ key: "admin\0user" })
    await expect(first.peek({ key: "admin\0user" })).resolves.toMatchObject({ status: "known", used: 1 })
    await expect(second.peek({ key: "user" })).resolves.toMatchObject({ status: "known", used: 0 })
  })

  it("isolates resets when names and keys contain null characters", async () => {
    const driver = memoryRateLimitDriver({ now: () => 1 })
    const first = createRateLimiter({ driver, limit: 1, name: "tenant", window: "1m" })
    const second = createRateLimiter({ driver, limit: 1, name: "tenant\0admin", window: "1m" })

    await second.consume({ key: "user" })
    await expect(first.reset({ key: "admin\0user" })).resolves.toEqual({ status: "reset" })
    await expect(second.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, used: 1 })
    await second.reset({ key: "user" })
    await expect(second.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, used: 1 })
  })

  it("fails closed at capacity without evicting live counters", async () => {
    const driver = memoryRateLimitDriver({ maxEntries: 1, now: () => 1 })
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.consume({ key: "A" })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(limiter.consume({ key: "B" })).rejects.toThrow("reached maxEntries")
    await expect(limiter.consume({ key: "A" })).resolves.toMatchObject({ allowed: false, used: 1 })
    expect(driver.size()).toBe(1)
  })

  it("reclaims expired counters across different windows without resetting live limits", async () => {
    let now = 1
    const driver = memoryRateLimitDriver({ maxEntries: 2, now: () => now })
    const minute = createRateLimiter({ driver, limit: 1, name: "minute", window: "1m" })
    const second = createRateLimiter({ driver, limit: 1, name: "second", window: "1s" })
    await minute.consume({ key: "user" })
    await second.consume({ key: "old" })

    now = 1_000
    await expect(second.consume({ key: "new" })).resolves.toMatchObject({ allowed: true, used: 1 })
    await expect(minute.consume({ key: "user" })).resolves.toMatchObject({ allowed: false, used: 1 })
    expect(driver.size()).toBe(2)

    now = 60_000
    await expect(minute.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, used: 1 })
    expect(driver.size()).toBe(1)

    driver.clear()
    await second.consume({ key: "after-clear" })
    now = 61_000
    await expect(second.consume({ key: "after-clear" })).resolves.toMatchObject({ allowed: true, used: 1 })
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

  it.each([null, "60s", {}, [0], [1.5], [Number.NaN], new Array(1)])("rejects malformed supported windows: %j", windows => {
    expect(() => createRateLimiter({
      driver: {
        capabilities: { ...strictCapabilities, windows } as never,
        consume: () => [null, { allowed: true }],
        name: "malformed-windows",
      },
      limit: 1,
      window: "1m",
    })).toThrow("windows must contain positive integer milliseconds")
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
