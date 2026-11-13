import { expectTypeOf, it } from "vitest"

import { checkRateLimit, createRateLimiter, requireRateLimit } from "../src/index.ts"
import { cloudflareRateLimitDriver } from "../src/drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../src/drivers/memory.ts"
import { discoverRateLimitDeclarations, hubRateLimit } from "../src/vite.ts"

import type { H3Event } from "h3"
import type { Result } from "@vite-hub/runtime"
import type { CheckRateLimitErrorCode, RateLimitDecision, RateLimitDeclaration, RateLimitDriver, RateLimitDriverOutcome, RateLimitDriverResult, RateLimiter } from "../src/index.ts"

type H3EventWithHostContext = Omit<H3Event, "req"> & {
  readonly req: Omit<H3Event["req"], "context"> & {
    readonly context?: { readonly platform?: unknown }
  }
}

it("types the portable Rate Limit contract", async () => {
  // SAFETY: This type-only fixture is never evaluated and exists to exercise the request event contract.
  const event = {} as H3EventWithHostContext
  expectTypeOf(await requireRateLimit(event, "uploads", { enforcement: "strict", failure: "deny", limit: 10, window: "1m" })).toEqualTypeOf<void>()
  expectTypeOf(await checkRateLimit(event, "uploads", { limit: 10, window: "1m" })).toEqualTypeOf<Result<RateLimitDecision, CheckRateLimitErrorCode>>()
  expectTypeOf(await requireRateLimit(event, "uploads", { key: "user", limit: 10, window: "1m" })).toEqualTypeOf<void>()
  const limiter = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: "1m" })
  expectTypeOf(limiter).toEqualTypeOf<RateLimiter>()
  expectTypeOf(await limiter.consume({ key: "user" })).toEqualTypeOf<RateLimitDecision>()
  expectTypeOf(limiter.capabilities.enforcement).toEqualTypeOf<"best-effort" | "strict">()

  // @ts-expect-error a managed Rate Limit requires a window.
  requireRateLimit(event, "uploads", { limit: 10 })
  expectTypeOf(await requireRateLimit(new Request("https://example.com"), "uploads", { key: "user", limit: 10, window: "1m" })).toEqualTypeOf<void>()
  // SAFETY: This type-only fixture is never evaluated. Auth passes the fields of a Request that it reads.
  const authRequest = {} as Pick<Request, "body" | "headers" | "method" | "signal" | "url">
  expectTypeOf(await checkRateLimit(authRequest, "uploads", { key: "user", limit: 10, window: "1m" })).toEqualTypeOf<Result<RateLimitDecision, CheckRateLimitErrorCode>>()
  // @ts-expect-error the guard requires a Request or an event with Standard Context properties.
  requireRateLimit({}, "uploads", { limit: 10, window: "1m" })
  // @ts-expect-error check is not a portable atomic operation.
  limiter.check({ key: "user" })
  // @ts-expect-error host events are not part of portable consumption.
  limiter.consume({ event: {}, key: "user" })
})

it("types custom and provider drivers", async () => {
  const unavailable = [new Error("offline"), undefined] satisfies RateLimitDriverOutcome
  const custom: RateLimitDriver = {
    capabilities: {
      enforcement: "strict",
      rejectedAttempts: "not-counted",
      scope: "global",
    },
    consume: async () => [null, { allowed: true, remaining: 1 }],
    name: "custom",
  }
  createRateLimiter({ driver: custom, limit: 2, window: "10s" })
  const [error, value] = await custom.consume({ key: "user", limit: 2, windowMs: 10_000 })
  if (error) throw error
  expectTypeOf(value).toEqualTypeOf<RateLimitDriverResult>()
  void unavailable
  createRateLimiter({ driver: cloudflareRateLimitDriver({ binding: { limit: async () => ({ success: true }) } }), limit: 2, window: "10s" })
  hubRateLimit({ namespace: "types-test", provider: "cloudflare", projectRoot: "../", scanDirs: ["shared"] })
  expectTypeOf(discoverRateLimitDeclarations({ rootDir: "." })).toEqualTypeOf<RateLimitDeclaration[]>()

  hubRateLimit({ provider: "kv" })
  // @ts-expect-error redis is a KV driver, not a Rate Limit provider.
  hubRateLimit({ provider: "redis" })
})
