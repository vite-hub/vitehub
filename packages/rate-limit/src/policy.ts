import type { RateLimitPolicy, RateLimitWindow, ResolvedRateLimitPolicy } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

export const rateLimitPolicyKeys: ReadonlySet<string> = new Set(["enforcement", "failure", "limit", "window"])

const unitMilliseconds = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  ms: 1,
  s: 1_000,
} as const

function parseRateLimitWindow(value: RateLimitWindow): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value)
  if (!match) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0031({ message: "[vitehub] Rate Limit window must use a duration such as \"10s\", \"1m\", \"1h\", or \"1d\"." })
  }

  // SAFETY: The duration regex limits the unit capture to keys in unitMilliseconds.
  const unitMs = unitMilliseconds[match[2] as keyof typeof unitMilliseconds]
  const [integer, fraction = ""] = match[1]!.split(".")
  // Number can round a fraction above the timestamp limit back down to the limit.
  const fractionalOverflow = Number(integer) === 8.64e15 / unitMs && /[1-9]/.test(fraction)
  const windowMs = Math.ceil(Number(match[1]) * unitMs)
  if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > 8.64e15 || fractionalOverflow) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0032({ message: "[vitehub] Rate Limit window must resolve to finite milliseconds greater than zero and at most 8640000000000000." })
  }

  return windowMs
}

export function normalizeRateLimitPolicy(policy: RateLimitPolicy): ResolvedRateLimitPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0033({ message: "[vitehub] Rate Limit policy must be an object." })
  }
  if (!Number.isInteger(policy.limit) || policy.limit <= 0) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0034({ message: "[vitehub] Rate Limit limit must be a positive integer." })
  }
  if (policy.enforcement !== undefined && policy.enforcement !== "best-effort" && policy.enforcement !== "strict") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0035({ message: "[vitehub] Rate Limit enforcement must be \"best-effort\" or \"strict\"." })
  }
  if (policy.failure !== undefined && policy.failure !== "allow" && policy.failure !== "deny") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0036({ message: "[vitehub] Rate Limit failure must be \"allow\" or \"deny\"." })
  }

  return {
    enforcement: policy.enforcement ?? "best-effort",
    failure: policy.failure ?? "deny",
    limit: policy.limit,
    window: policy.window,
    windowMs: parseRateLimitWindow(policy.window),
  }
}

export function declaredRateLimitPolicy(policy: ResolvedRateLimitPolicy): RateLimitPolicy {
  return {
    enforcement: policy.enforcement,
    failure: policy.failure,
    limit: policy.limit,
    window: policy.window,
  }
}
