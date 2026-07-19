import { AsyncLocalStorage } from "node:async_hooks"

import { clearActiveCloudflareEnv, getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { describe, expect, it, vi } from "vitest"

import { createRateLimiter } from "../src/index.ts"
import { cloudflareRateLimitDriver, getCloudflareRateLimitBindingName } from "../src/drivers/cloudflare.ts"
import { enterRateLimitRuntimeEvent, getRateLimitRuntimeEvent, runWithRateLimitRuntimeEvent } from "../src/runtime.ts"
import { getRateLimitRuntimeRequestKey } from "../src/runtime/state.ts"

describe("Cloudflare Rate Limit driver", () => {
  it("sets the Cloudflare environment when enterWith is unavailable", () => {
    const env = { RATE_LIMITER: {} }
    const enterWith = vi.spyOn(AsyncLocalStorage.prototype, "enterWith").mockImplementation(() => {
      throw new Error("enterWith is unavailable")
    })

    try {
      const event = { env }
      expect(() => enterRateLimitRuntimeEvent(event, "client-1")).not.toThrow()
      expect(getActiveCloudflareEnv()).toBe(env)
      expect(getRateLimitRuntimeEvent()).toBe(event)
      expect(getRateLimitRuntimeRequestKey()).toBe("client-1")
    }
    finally {
      enterWith.mockRestore()
      clearActiveCloudflareEnv()
    }
  })

  it("resolves the named binding from ViteHub's Cloudflare event seam", async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const name = "image-upload"
    const limiter = createRateLimiter({
      driver: cloudflareRateLimitDriver({ name }),
      limit: 10,
      name,
      window: "1m",
    })

    await expect(runWithRateLimitRuntimeEvent(
      { context: { cloudflare: { env: { [getCloudflareRateLimitBindingName(name)]: { limit } } } } },
      () => limiter.consume({ key: "user-1" }),
    )).resolves.toMatchObject({ allowed: false, reason: "limited" })
    expect(limit).toHaveBeenCalledWith({ key: "user-1" })
    expect(limiter.capabilities).toMatchObject({
      enforcement: "best-effort",
      metadata: { remaining: { availability: "never" } },
      rejectedAttempts: "unknown",
      scope: "location",
    })
  })

  it("fails when the binding is missing", async () => {
    const limiter = createRateLimiter({
      driver: cloudflareRateLimitDriver({ name: "uploads" }),
      limit: 10,
      window: "10s",
    })
    await expect(runWithRateLimitRuntimeEvent(
      { env: {} },
      () => limiter.consume({ key: "user-1" }),
    )).rejects.toThrow("was not found")
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
