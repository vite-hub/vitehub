import { expectTypeOf, it } from "vitest"

import { createRateLimiter, defineRateLimit } from "../src/index.ts"
import { cloudflareRateLimitDriver } from "../src/drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"
import { hubRateLimit } from "../src/vite.ts"

import type { RateLimitDecision, RateLimitDriver, RateLimiter } from "../src/index.ts"

it("types the portable Rate Limit contract", async () => {
  const uploads = defineRateLimit("uploads", { enforcement: "strict", failure: "deny", limit: 10, window: "1m" })
  expectTypeOf(await uploads.consume("user")).toEqualTypeOf<RateLimitDecision>()
  const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: "1m" })
  expectTypeOf(limiter).toEqualTypeOf<RateLimiter>()
  expectTypeOf(await limiter.consume({ key: "user" })).toEqualTypeOf<RateLimitDecision>()
  expectTypeOf(limiter.capabilities.scope).toEqualTypeOf<"global" | "location" | "process">()

  // @ts-expect-error a defined Rate Limit requires a stable ID and a window.
  defineRateLimit("uploads", { limit: 10 })
  // @ts-expect-error managed handles accept the key directly.
  uploads.consume({ key: "user" })
  // @ts-expect-error check is not a portable atomic operation.
  limiter.check({ key: "user" })
  // @ts-expect-error host events are not part of portable consumption.
  limiter.consume({ event: {}, key: "user" })
})

it("types custom and provider drivers", () => {
  const custom = {
    capabilities: {
      enforcement: "strict",
      metadata: {
        remaining: { availability: "always", quality: "exact" },
        resetAt: { availability: "never" },
        retryAfter: { availability: "never" },
        used: { availability: "never" },
      },
      rejectedAttempts: "not-counted",
      scope: "global",
    },
    consume: async () => ({ allowed: true, remaining: 1 }),
    name: "custom",
  } satisfies RateLimitDriver
  createRateLimiter({ driver: custom, limit: 2, window: "10s" })
  createRateLimiter({ driver: cloudflareRateLimitDriver({ name: "uploads" }), limit: 2, window: "10s" })
  hubRateLimit({ namespace: "types-test", provider: "cloudflare", projectRoot: "../", scanDirs: ["shared"] })

  // @ts-expect-error kv is not a Rate Limit provider.
  hubRateLimit({ provider: "kv" })
})
