import { expectTypeOf, it } from "vitest"

import { createRateLimiter, requireRateLimit } from "../src/index.ts"
import { cloudflareRateLimitDriver } from "../src/drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"
import { hubRateLimit } from "../src/vite.ts"

import type { HTTPEvent } from "h3"
import type { RateLimitDecision, RateLimitDriver, RateLimitDriverOutcome, RateLimiter } from "../src/index.ts"

it("types the portable Rate Limit contract", async () => {
  const event = {} as HTTPEvent
  expectTypeOf(await requireRateLimit(event, "uploads", { enforcement: "strict", failure: "deny", limit: 10, window: "1m" })).toEqualTypeOf<void>()
  expectTypeOf(await requireRateLimit(event, "uploads", { key: "user", limit: 10, window: "1m" })).toEqualTypeOf<void>()
  const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: "1m" })
  expectTypeOf(limiter).toEqualTypeOf<RateLimiter>()
  expectTypeOf(await limiter.consume({ key: "user" })).toEqualTypeOf<RateLimitDecision>()
  expectTypeOf(limiter.capabilities.enforcement).toEqualTypeOf<"best-effort" | "strict">()

  // @ts-expect-error a managed Rate Limit requires a window.
  requireRateLimit(event, "uploads", { limit: 10 })
  // @ts-expect-error the guard requires an H3 event.
  requireRateLimit({}, "uploads", { limit: 10, window: "1m" })
  // @ts-expect-error check is not a portable atomic operation.
  limiter.check({ key: "user" })
  // @ts-expect-error host events are not part of portable consumption.
  limiter.consume({ event: {}, key: "user" })
})

it("types custom and provider drivers", () => {
  const unavailable = { cause: new Error("offline"), unavailable: true } satisfies RateLimitDriverOutcome
  const custom = {
    capabilities: {
      enforcement: "strict",
      rejectedAttempts: "not-counted",
      scope: "global",
    },
    consume: async () => ({ allowed: true, remaining: 1 }),
    name: "custom",
  } satisfies RateLimitDriver
  createRateLimiter({ driver: custom, limit: 2, window: "10s" })
  void unavailable
  createRateLimiter({ driver: cloudflareRateLimitDriver({ binding: { limit: async () => ({ success: true }) } }), limit: 2, window: "10s" })
  hubRateLimit({ namespace: "types-test", provider: "cloudflare", projectRoot: "../", scanDirs: ["shared"] })

  // @ts-expect-error kv is not a Rate Limit provider.
  hubRateLimit({ provider: "kv" })
})
