import { afterEach, describe, expect, it, vi } from "vitest"

import { createRateLimiter } from "../src/index.ts"
import { cloudflareRateLimitDriver } from "../src/drivers/cloudflare.ts"
import { kvRateLimitDriver } from "../src/drivers/kv.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"

import type { RateLimitDriver } from "../src/index.ts"

afterEach(() => {
  vi.useRealTimers()
})

const input = { key: "user", limit: 2, name: "uploads", windowMs: 60_000 }

function kvDriver() {
  const values = new Map<string, number>()
  return kvRateLimitDriver({
    storage: {
      delete: async (key) => {
        values.delete(key)
        return [undefined, undefined]
      },
      get: async key => [undefined, values.get(key) ?? null],
      increment: async (key) => {
        const value = (values.get(key) ?? 0) + 1
        values.set(key, value)
        return [undefined, value]
      },
    },
  })
}

describe("built-in Rate Limit drivers return a Result", () => {
  it.each([
    ["memory", () => memoryRateLimitDriver()],
    ["kv", kvDriver],
  ] as const)("%s: consume, peek and reset return [undefined, value]", async (_name, create) => {
    const driver = create()
    const consumed = await driver.consume(input)
    expect(consumed).toHaveLength(2)
    expect(consumed[0]).toBeUndefined()
    expect(consumed[1]).toMatchObject({ allowed: true, used: 1 })

    const peeked = await driver.peek(input)
    expect(peeked).toHaveLength(2)
    expect(peeked[0]).toBeUndefined()
    expect(peeked[1]).toMatchObject({ used: 1 })

    expect(await driver.reset(input)).toEqual([undefined, undefined])
  })

  it("cloudflare: consume returns [undefined, value]", async () => {
    const driver = cloudflareRateLimitDriver({ binding: { limit: async () => ({ success: true }) } })
    expect(await driver.consume(input)).toEqual([undefined, { allowed: true }])
  })

  it("cloudflare: a binding failure is a coded error with the binding error as cause", async () => {
    const cause = new Error("binding offline")
    const driver = cloudflareRateLimitDriver({ binding: { limit: async () => { throw cause } } })
    const [error, value] = await driver.consume(input)
    expect(value).toBeUndefined()
    expect(error).toMatchObject({ cause, code: "RATE_LIMIT_R0005", fix: expect.any(String), name: "RATE_LIMIT_R0005" })
  })

  it("kv: a stalled store is a coded timeout error", async () => {
    vi.useFakeTimers()
    const driver = kvRateLimitDriver({ storage: { delete: () => new Promise(() => {}), get: () => new Promise(() => {}), increment: () => new Promise(() => {}) } })
    const outcome = driver.consume(input)
    await vi.advanceTimersByTimeAsync(1_000)
    const [error, value] = await outcome
    expect(value).toBeUndefined()
    expect(error).toMatchObject({ code: "RATE_LIMIT_KV_TIMEOUT", fix: expect.any(String), name: "RATE_LIMIT_KV_TIMEOUT" })
  })
})

describe("custom Rate Limit drivers", () => {
  const capabilities = { enforcement: "strict", rejectedAttempts: "not-counted", scope: "global" } as const

  it("accepts the Result shape for consume, peek and reset", async () => {
    const driver: RateLimitDriver = {
      capabilities,
      consume: () => [undefined, { allowed: true, remaining: 1 }],
      name: "custom",
      peek: () => [undefined, { used: 1 }],
      reset: () => [undefined, undefined],
    }
    const limiter = createRateLimiter({ driver, limit: 2, window: "1m" })
    await expect(limiter.consume({ key: "user" })).resolves.toMatchObject({ allowed: true, remaining: 1 })
    await expect(limiter.peek({ key: "user" })).resolves.toMatchObject({ status: "known", used: 1 })
    await expect(limiter.reset({ key: "user" })).resolves.toEqual({ status: "reset" })
  })

  it("rejects the old null tuples with a fix that names the Result shape", async () => {
    // SAFETY: The test sends the tuples that the contract no longer accepts.
    const driver = { capabilities, consume: () => [null, { allowed: true }], name: "legacy", peek: () => [null, { used: 0 }], reset: () => [null] } as never
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.consume({ key: "user" })).rejects.toMatchObject({ code: "RATE_LIMIT_R0044", fix: expect.stringContaining("`[undefined, result]`") })
    await expect(limiter.peek({ key: "user" })).rejects.toMatchObject({ code: "RATE_LIMIT_R0043", fix: expect.stringContaining("`[undefined, result]`") })
    await expect(limiter.reset({ key: "user" })).rejects.toMatchObject({ code: "RATE_LIMIT_R0042", fix: expect.stringContaining("`[undefined, undefined]`") })
  })
})
