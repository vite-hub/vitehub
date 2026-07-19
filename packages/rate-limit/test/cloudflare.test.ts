import { describe, expect, it, vi } from "vitest"

import { createRateLimiter } from "../src/index.ts"
import { cloudflareRateLimitDriver } from "../src/drivers/cloudflare.ts"

describe("Cloudflare Rate Limit driver", () => {
  it("consumes an explicit Cloudflare binding", async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const name = "image-upload"
    const limiter = createRateLimiter({
      driver: cloudflareRateLimitDriver({ binding: { limit } }),
      limit: 10,
      name,
      window: "1m",
    })

    await expect(limiter.consume({ key: "user-1" })).resolves.toMatchObject({ allowed: false, reason: "limited" })
    expect(limit).toHaveBeenCalledWith({ key: "user-1" })
    expect(limiter.capabilities).toMatchObject({
      enforcement: "best-effort",
      metadata: { remaining: { availability: "never" } },
      rejectedAttempts: "unknown",
      scope: "location",
    })
  })

  it("requires an explicit binding", () => {
    expect(() => cloudflareRateLimitDriver({} as never)).toThrow("requires a Cloudflare Rate Limit binding")
  })

  it("reports provider call failures as unavailable", async () => {
    const cause = new Error("provider unavailable")
    const limiter = createRateLimiter({
      driver: cloudflareRateLimitDriver({
        binding: { limit: async () => { throw cause } },
      }),
      failure: "deny",
      limit: 10,
      window: "10s",
    })

    await expect(limiter.consume({ key: "user-1" })).resolves.toMatchObject({
      allowed: false,
      cause,
      reason: "unavailable",
    })
  })

  it("does not classify malformed provider responses as unavailability", async () => {
    const limiter = createRateLimiter({
      driver: cloudflareRateLimitDriver({
        binding: { limit: async () => ({ success: "yes" } as never) },
      }),
      failure: "allow",
      limit: 10,
      window: "10s",
    })

    await expect(limiter.consume({ key: "user-1" })).rejects.toThrow("returned an invalid result")
  })
})
