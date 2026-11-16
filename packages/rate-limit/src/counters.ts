import * as v from "valibot"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"
import { listRuntimeRateLimiters, resolveRateLimitProvider } from "./runtime/state.ts"

import type { RateLimitCounterScope, RateLimiter, RateLimitRuntimeConfig, RateLimitWindow } from "./types.ts"

type RateLimitRuntimeProvider = RateLimitRuntimeConfig["provider"]

/** Counter of one key for one policy. `peekRateLimit()` reads it without consuming a token. */
export interface RateLimitCounterSnapshot {
  limit: number
  remaining: number
  /** End of the current window in epoch milliseconds. Absent when the key has no active counter. */
  resetAt?: number
  used: number
  window: RateLimitWindow
  windowMs: number
}

interface RateLimitCounterTarget {
  key: string
  name: string
  provider: RateLimitRuntimeProvider
}

export type RateLimitPeekInspection =
  | (RateLimitCounterTarget & {
    /** One entry for each policy that requests used with this name. Usually one. */
    counters: RateLimitCounterSnapshot[]
    /** Where the counter lives. A `process` counter exists only in the current server process. */
    scope: RateLimitCounterScope
    status: "known"
  })
  | (RateLimitCounterTarget & { reason: string, status: "unavailable" | "unsupported" | "unused" })

export type RateLimitResetInspection =
  | (RateLimitCounterTarget & { scope: RateLimitCounterScope, status: "reset" })
  | (RateLimitCounterTarget & { reason: string, status: "unavailable" | "unsupported" })

/** Reason that Cloudflare counters are not readable. The binding exposes only `limit({ key })`. */
const cloudflareRateLimitCounterUnsupportedReason = "The Cloudflare Rate Limiting binding exposes only limit(), which consumes a token. It cannot read or reset a counter."

const unusedReason = "No request used this Rate Limit in this process since it started, so no counter exists."
/** A `kv` counter is shared, but the policy that names its window comes from the requests of this process. */
const unusedKVReason = "No request used this Rate Limit in this process since it started, so this process does not know its window. Other processes can still have a counter."

function unavailableReason(cause: unknown): string {
  return `The Rate Limit driver failed: ${cause instanceof Error ? cause.message : String(cause)}`
}

function assertTarget(name: string, key: string): void {
  if (!v.is(v.string(), name) || !name.trim()) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0039({ message: "[vitehub] Rate Limit name must be a non-empty string." })
  }
  if (!v.is(v.string(), key) || !key) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0039({ message: "[vitehub] Rate Limit key must be a non-empty string." })
  }
}

function limitersFor(target: RateLimitCounterTarget): RateLimiter[] | undefined {
  return target.provider === "cloudflare" ? undefined : listRuntimeRateLimiters(target.name)
}

/**
 * Reads the counter of one key without consuming a token. The result reports `unsupported` when the configured
 * provider cannot read counters, and `unused` when no request used the Rate Limit in this process.
 */
export async function peekRateLimit(name: string, key: string): Promise<RateLimitPeekInspection> {
  assertTarget(name, key)
  const target: RateLimitCounterTarget = { key, name: name.trim(), provider: await resolveRateLimitProvider() }
  const limiters = limitersFor(target)
  if (!limiters) return { ...target, reason: cloudflareRateLimitCounterUnsupportedReason, status: "unsupported" }
  if (limiters.length === 0) return { ...target, reason: target.provider === "kv" ? unusedKVReason : unusedReason, status: "unused" }
  const counters: RateLimitCounterSnapshot[] = []
  for (const limiter of limiters) {
    const result = await limiter.peek({ key })
    if (result.status === "unsupported") return { ...target, reason: result.reason, status: "unsupported" }
    if (result.status === "unavailable") return { ...target, reason: unavailableReason(result.cause), status: "unavailable" }
    counters.push({
      limit: result.limit,
      remaining: result.remaining,
      ...(result.resetAt === undefined ? {} : { resetAt: result.resetAt }),
      used: result.used,
      window: limiter.policy.window,
      windowMs: result.windowMs,
    })
  }
  return { ...target, counters, scope: limiters[0]!.capabilities.scope, status: "known" }
}

/**
 * Deletes the counter of one key, so the next request starts a new window. A key without a counter also returns
 * `reset`. The result reports `unsupported` when the configured provider cannot reset counters.
 */
export async function resetRateLimit(name: string, key: string): Promise<RateLimitResetInspection> {
  assertTarget(name, key)
  const target: RateLimitCounterTarget = { key, name: name.trim(), provider: await resolveRateLimitProvider() }
  const limiters = limitersFor(target)
  if (!limiters) return { ...target, reason: cloudflareRateLimitCounterUnsupportedReason, status: "unsupported" }
  if (limiters.length === 0 && target.provider === "kv") return { ...target, reason: unusedKVReason, status: "unsupported" }
  for (const limiter of limiters) {
    const result = await limiter.reset({ key })
    if (result.status === "unsupported") return { ...target, reason: result.reason, status: "unsupported" }
    if (result.status === "unavailable") return { ...target, reason: unavailableReason(result.cause), status: "unavailable" }
  }
  // No limiter exists only for memory here, so the counter scope is the process.
  return { ...target, scope: limiters[0]?.capabilities.scope ?? "process", status: "reset" }
}
