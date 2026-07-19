import type { RateLimitPolicy, RateLimitWindow, ResolvedRateLimitPolicy } from "./types.ts"

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
    throw new TypeError("[vitehub] Rate Limit window must use a duration such as \"10s\", \"1m\", \"1h\", or \"1d\".")
  }

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new TypeError("[vitehub] Rate Limit window must be greater than zero.")
  }

  return Math.ceil(amount * unitMilliseconds[match[2] as keyof typeof unitMilliseconds])
}

export function normalizeRateLimitPolicy(policy: RateLimitPolicy): ResolvedRateLimitPolicy {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("[vitehub] Rate Limit policy must be an object.")
  }
  if (!Number.isInteger(policy.limit) || policy.limit <= 0) {
    throw new TypeError("[vitehub] Rate Limit limit must be a positive integer.")
  }
  if (policy.enforcement !== undefined && policy.enforcement !== "best-effort" && policy.enforcement !== "strict") {
    throw new TypeError("[vitehub] Rate Limit enforcement must be \"best-effort\" or \"strict\".")
  }
  if (policy.failure !== undefined && policy.failure !== "allow" && policy.failure !== "deny") {
    throw new TypeError("[vitehub] Rate Limit failure must be \"allow\" or \"deny\".")
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
