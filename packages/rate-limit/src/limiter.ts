import { normalizeRateLimitPolicy } from "./policy.ts"

import type { CreateRateLimiterOptions, RateLimitDecision, RateLimitDriverCapabilities, RateLimitDriverResult, RateLimiter } from "./types.ts"

function resolveDriverCapabilities(options: CreateRateLimiterOptions): RateLimitDriverCapabilities {
  const capabilities = options.driver.capabilities
  if (!capabilities || typeof capabilities !== "object") {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" must declare capabilities.`)
  }
  if (capabilities.enforcement !== "best-effort" && capabilities.enforcement !== "strict") {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" must declare valid enforcement.`)
  }
  if (capabilities.scope !== "process" && capabilities.scope !== "location" && capabilities.scope !== "global") {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" must declare counter scope.`)
  }
  if (capabilities.rejectedAttempts !== "counted" && capabilities.rejectedAttempts !== "not-counted" && capabilities.rejectedAttempts !== "unknown") {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" must declare rejected-attempt behavior.`)
  }
  if (capabilities.windows?.some(window => !Number.isInteger(window) || window <= 0)) {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" windows must contain positive integer milliseconds.`)
  }
  return {
    enforcement: capabilities.enforcement,
    rejectedAttempts: capabilities.rejectedAttempts,
    scope: capabilities.scope,
    ...(capabilities.windows ? { windows: [...capabilities.windows] } : {}),
  }
}

function normalizeOptionalInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`[vitehub] Rate Limit driver result ${label} must be a non-negative integer.`)
  }
  return value
}

function normalizeDriverResult(
  result: RateLimitDriverResult,
  limit: number,
  windowMs: number,
): RateLimitDecision {
  if (!result || typeof result !== "object" || typeof result.allowed !== "boolean") {
    throw new TypeError("[vitehub] Rate Limit driver consume() must return an object with an allowed boolean.")
  }
  const resetAt = result.resetAt
  if (resetAt !== undefined && (!Number.isFinite(resetAt) || resetAt <= 0)) {
    throw new TypeError("[vitehub] Rate Limit driver result resetAt must be a positive timestamp.")
  }

  const decision = {
    limit,
    remaining: normalizeOptionalInteger(result.remaining, "remaining"),
    resetAt,
    retryAfter: normalizeOptionalInteger(result.retryAfter, "retryAfter"),
    used: normalizeOptionalInteger(result.used, "used"),
    windowMs,
  }
  return result.allowed
    ? { ...decision, allowed: true }
    : { ...decision, allowed: false, reason: "limited" }
}

function assertDriverSupportsPolicy(options: CreateRateLimiterOptions, capabilities: RateLimitDriverCapabilities, windowMs: number): void {
  const requestedEnforcement = options.enforcement ?? "best-effort"
  if (requestedEnforcement === "strict" && capabilities.enforcement !== "strict") {
    throw new Error(`[vitehub] Rate Limit driver "${options.driver.name}" provides best-effort enforcement, but this policy requires strict enforcement.`)
  }
  const windows = capabilities.windows
  if (windows?.length && !windows.includes(windowMs)) {
    throw new Error(`[vitehub] Rate Limit driver "${options.driver.name}" does not support a ${windowMs}ms window. Supported windows: ${windows.join(", ")}ms.`)
  }
}

export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  if (!options.driver || typeof options.driver.consume !== "function") {
    throw new TypeError("[vitehub] createRateLimiter() requires a Rate Limit driver.")
  }
  const policy = normalizeRateLimitPolicy(options)
  const capabilities = resolveDriverCapabilities(options)
  assertDriverSupportsPolicy(options, capabilities, policy.windowMs)

  return {
    capabilities,
    async consume(input) {
      if (!input || typeof input.key !== "string" || input.key.length === 0) {
        throw new TypeError("[vitehub] Rate Limiter consume() requires a non-empty key.")
      }
      const [error, result] = await options.driver.consume({
        key: input.key,
        limit: policy.limit,
        name: options.name,
        windowMs: policy.windowMs,
      })
      if (error) {
        return {
          allowed: policy.failure === "allow",
          cause: error.cause ?? error,
          limit: policy.limit,
          reason: "unavailable",
          windowMs: policy.windowMs,
        }
      }
      return normalizeDriverResult(result, policy.limit, policy.windowMs)
    },
    policy,
  }
}
