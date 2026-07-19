import { normalizeRateLimitPolicy } from "./policy.ts"

import type { CreateRateLimiterOptions, RateLimitDecision, RateLimitDriverCapabilities, RateLimitDriverResult, RateLimiter, RateLimitMetadataCapability } from "./types.ts"

function resolveMetadataCapability(value: RateLimitMetadataCapability | undefined, driverName: string, field: string): RateLimitMetadataCapability {
  if (!value || (value.availability !== "always" && value.availability !== "never" && value.availability !== "on-rejection")) {
    throw new TypeError(`[vitehub] Rate Limit driver "${driverName}" must declare ${field} metadata availability.`)
  }
  if (value.availability === "never") {
    if (value.quality !== undefined) {
      throw new TypeError(`[vitehub] Rate Limit driver "${driverName}" cannot declare ${field} metadata quality when it is unavailable.`)
    }
    return { availability: "never" }
  }
  if (value.quality !== "approximate" && value.quality !== "exact") {
    throw new TypeError(`[vitehub] Rate Limit driver "${driverName}" must declare ${field} metadata quality.`)
  }
  return { availability: value.availability, quality: value.quality }
}

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
  const metadata = capabilities.metadata
  if (!metadata) {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" must declare metadata capabilities.`)
  }
  if (capabilities.windows?.some(window => !Number.isInteger(window) || window <= 0)) {
    throw new TypeError(`[vitehub] Rate Limit driver "${options.driver.name}" windows must contain positive integer milliseconds.`)
  }
  return {
    enforcement: capabilities.enforcement,
    metadata: {
      remaining: resolveMetadataCapability(metadata.remaining, options.driver.name, "remaining"),
      resetAt: resolveMetadataCapability(metadata.resetAt, options.driver.name, "resetAt"),
      retryAfter: resolveMetadataCapability(metadata.retryAfter, options.driver.name, "retryAfter"),
      used: resolveMetadataCapability(metadata.used, options.driver.name, "used"),
    },
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

function assertMetadataResult(
  result: RateLimitDriverResult,
  capabilities: RateLimitDriverCapabilities,
  driverName: string,
  field: keyof RateLimitDriverCapabilities["metadata"],
): void {
  const capability = capabilities.metadata[field]
  const returned = Object.prototype.hasOwnProperty.call(result, field)
  const value = result[field]
  const required = capability.availability === "always"
    || (capability.availability === "on-rejection" && !result.allowed)
  const forbidden = capability.availability === "never"
    || (capability.availability === "on-rejection" && result.allowed)

  if (required && value === undefined) {
    throw new TypeError(`[vitehub] Rate Limit driver "${driverName}" declared ${field} metadata ${capability.availability}, but consume() omitted it.`)
  }
  if (forbidden && returned) {
    throw new TypeError(`[vitehub] Rate Limit driver "${driverName}" declared ${field} metadata ${capability.availability}, but consume() returned it.`)
  }
}

function normalizeDriverResult(
  result: RateLimitDriverResult,
  limit: number,
  windowMs: number,
  capabilities: RateLimitDriverCapabilities,
  driverName: string,
): RateLimitDecision {
  if (!result || typeof result !== "object" || typeof result.allowed !== "boolean") {
    throw new TypeError("[vitehub] Rate Limit driver consume() must return an object with an allowed boolean.")
  }
  assertMetadataResult(result, capabilities, driverName, "remaining")
  assertMetadataResult(result, capabilities, driverName, "resetAt")
  assertMetadataResult(result, capabilities, driverName, "retryAfter")
  assertMetadataResult(result, capabilities, driverName, "used")
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
      const result = await options.driver.consume({
        key: input.key,
        limit: policy.limit,
        name: options.name,
        windowMs: policy.windowMs,
      })
      if ("unavailable" in result) {
        if (result.unavailable !== true) {
          throw new TypeError("[vitehub] Rate Limit driver unavailable outcome must set unavailable to true.")
        }
        return {
          allowed: policy.failure === "allow",
          cause: result.cause,
          limit: policy.limit,
          reason: "unavailable",
          windowMs: policy.windowMs,
        }
      }
      return normalizeDriverResult(result, policy.limit, policy.windowMs, capabilities, options.driver.name)
    },
    policy,
  }
}
