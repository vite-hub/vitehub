import { parseDuration } from "@vite-hub/runtime"

import type { Duration } from "@vite-hub/runtime"
import type { RateLimitPolicy, ResolvedRateLimitPolicy } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

export const rateLimitPolicyKeys: ReadonlySet<string> = new Set(["enforcement", "failure", "limit", "window"])

export function parseRateLimitWindow(value: Duration): number {
  const windowMs = parseDuration(value, "window", "ceil")
  if (windowMs <= 0 || windowMs > 8.64e15) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0032({ message: "[vitehub] Rate Limit window must resolve to milliseconds greater than zero and at most 8640000000000000." })
  }
  return windowMs
}

export function normalizeRateLimitPolicy(policy: RateLimitPolicy): ResolvedRateLimitPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0033({ message: "[vitehub] Rate Limit policy must be an object." })
  }
  const limit = Object.hasOwn(policy, "limit") ? policy.limit : undefined
  const duration = Object.hasOwn(policy, "window") ? policy.window : undefined
  const enforcement = Object.hasOwn(policy, "enforcement") ? policy.enforcement : undefined
  const failure = Object.hasOwn(policy, "failure") ? policy.failure : undefined
  if (limit === undefined || !Number.isInteger(limit) || limit <= 0) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0034({ message: "[vitehub] Rate Limit limit must be a positive integer." })
  }
  if (typeof duration !== "string") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0031({ message: `[vitehub] Rate Limit window must be a duration string such as "10s", "1m", "1h", or "1d", not ${typeof duration === "number" ? `the number ${duration}` : `a ${typeof duration}`}.` })
  }
  if (enforcement !== undefined && enforcement !== "best-effort" && enforcement !== "strict") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0035({ message: "[vitehub] Rate Limit enforcement must be \"best-effort\" or \"strict\"." })
  }
  if (failure !== undefined && failure !== "allow" && failure !== "deny") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0036({ message: "[vitehub] Rate Limit failure must be \"allow\" or \"deny\"." })
  }

  return {
    enforcement: enforcement ?? "best-effort",
    failure: failure ?? "deny",
    limit,
    window: duration,
    windowMs: parseRateLimitWindow(duration),
  }
}

export function rateLimitPolicyKey(policy: RateLimitPolicy): string {
  const { enforcement, failure, limit, windowMs } = normalizeRateLimitPolicy(policy)
  return JSON.stringify([enforcement, failure, limit, windowMs])
}

export function declaredRateLimitPolicy(policy: ResolvedRateLimitPolicy): RateLimitPolicy {
  return {
    enforcement: policy.enforcement,
    failure: policy.failure,
    limit: policy.limit,
    window: policy.window,
  }
}
