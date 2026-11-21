import { describe, expect, it } from "vitest"

import { memoryRateLimitDriver } from "../src/drivers/memory.ts"
import { rateLimitErrorDiagnostics } from "../src/error-diagnostics.ts"
import { createRateLimiter } from "../src/index.ts"

import type { RateLimitDriver } from "../src/index.ts"

/** The runtime codes that a Rate Limit guard, a direct Rate Limiter, a driver, or `vitehub rate-limit` can raise. */
const runtimeCodes = [
  "RATE_LIMIT_R0001", "RATE_LIMIT_R0002", "RATE_LIMIT_R0003", "RATE_LIMIT_R0004", "RATE_LIMIT_R0005",
  "RATE_LIMIT_R0006", "RATE_LIMIT_R0007", "RATE_LIMIT_R0008", "RATE_LIMIT_R0009", "RATE_LIMIT_R0010",
  "RATE_LIMIT_R0011", "RATE_LIMIT_R0012", "RATE_LIMIT_R0013", "RATE_LIMIT_R0015", "RATE_LIMIT_R0016",
  "RATE_LIMIT_R0019", "RATE_LIMIT_R0020", "RATE_LIMIT_R0021", "RATE_LIMIT_R0022", "RATE_LIMIT_R0023",
  "RATE_LIMIT_R0024", "RATE_LIMIT_R0025", "RATE_LIMIT_R0026", "RATE_LIMIT_R0027", "RATE_LIMIT_R0028",
  "RATE_LIMIT_R0029", "RATE_LIMIT_R0030", "RATE_LIMIT_R0031", "RATE_LIMIT_R0032", "RATE_LIMIT_R0033",
  "RATE_LIMIT_R0034", "RATE_LIMIT_R0035", "RATE_LIMIT_R0036", "RATE_LIMIT_R0037", "RATE_LIMIT_R0038",
  "RATE_LIMIT_R0039", "RATE_LIMIT_R0040", "RATE_LIMIT_R0041", "RATE_LIMIT_R0042", "RATE_LIMIT_R0043",
  "RATE_LIMIT_R0044", "RATE_LIMIT_R0045",
] as const

describe("Rate Limit runtime error fixes", () => {
  it.each(runtimeCodes)("gives %s a fix and its own docs page", (code) => {
    const error = rateLimitErrorDiagnostics[code]({ message: "m" })
    expect(error.fix).toMatch(/\S/)
    expect(error.docs).toBe(`https://vitehub.dev/docs/rate-limit/diagnostics/${code.toLowerCase()}`)
  })

  it("names the policy option of an invalid window", () => {
    expect(() => createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window: 60_000 as never })).toThrow(expect.objectContaining({
      code: "RATE_LIMIT_R0031",
      fix: expect.stringContaining("`window`"),
    }))
    expect(() => createRateLimiter({ driver: memoryRateLimitDriver(), limit: 1, window: "soon" as never })).toThrow(expect.objectContaining({
      code: "RUNTIME_DURATION_INVALID",
      why: expect.stringContaining("`window`"),
    }))
  })

  it("names maxEntries for a memory driver without a valid cap", () => {
    expect(() => memoryRateLimitDriver({ maxEntries: 0 })).toThrow(expect.objectContaining({
      code: "RATE_LIMIT_R0007",
      fix: expect.stringContaining("`maxEntries`"),
    }))
  })

  it("tells a custom driver author what consume() must return", async () => {
    const driver: RateLimitDriver = {
      capabilities: { enforcement: "strict", rejectedAttempts: "not-counted", scope: "global" },
      // SAFETY: The test sends the result shape that the contract rejects.
      consume: async () => ({ allowed: true }) as never,
      name: "custom",
    }
    const limiter = createRateLimiter({ driver, limit: 1, window: "1m" })
    await expect(limiter.consume({ key: "user" })).rejects.toMatchObject({
      code: "RATE_LIMIT_R0044",
      fix: expect.stringContaining("`[undefined, result]`"),
    })
  })
})
