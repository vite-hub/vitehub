export { createRateLimiter } from "./limiter.ts"
export { requireRateLimit } from "./guard.ts"

export type {
  CreateRateLimiterOptions,
  RateLimitConsumeInput,
  RateLimitCounterScope,
  RateLimitDecision,
  RateLimitDriver,
  RateLimitDriverCapabilities,
  RateLimitDriverInput,
  RateLimitDriverOutcome,
  RateLimitDriverResult,
  RateLimitEnforcement,
  RateLimitFailurePolicy,
  RateLimiter,
  RateLimitModuleOptions,
  RateLimitPolicy,
  RateLimitProvider,
  RateLimitRejectedAttemptBehavior,
  RateLimitRequestEvent,
  RateLimitRuntimeConfig,
  RateLimitWindow,
  RequireRateLimitOptions,
  ResolvedRateLimitPolicy,
} from "./types.ts"
