export type MaybePromise<T> = Promise<T> | T

export type RateLimitWindow =
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`

export type RateLimitEnforcement = "best-effort" | "strict"
export type RateLimitFailurePolicy = "allow" | "deny"
export type RateLimitCounterScope = "global" | "location" | "process"
export type RateLimitMetadataAvailability = "always" | "never" | "on-rejection"
export type RateLimitMetadataQuality = "approximate" | "exact"
export type RateLimitRejectedAttemptBehavior = "counted" | "not-counted" | "unknown"

export interface RateLimitMetadataCapability {
  readonly availability: RateLimitMetadataAvailability
  readonly quality?: RateLimitMetadataQuality
}

export interface RateLimitPolicy {
  enforcement?: RateLimitEnforcement
  failure?: RateLimitFailurePolicy
  limit: number
  window: RateLimitWindow
}

export interface ResolvedRateLimitPolicy {
  enforcement: RateLimitEnforcement
  failure: RateLimitFailurePolicy
  limit: number
  window: RateLimitWindow
  windowMs: number
}

export type RateLimitDefinition = RateLimitPolicy

export interface RateLimitDefinitionRegistry {
  [name: string]: () => MaybePromise<{ default?: RateLimitDefinition } | RateLimitDefinition>
}

export interface DiscoveredRateLimitDefinition {
  handler: string
  name: string
  source?: "server-rate-limits" | "vite-suffix"
}

export interface RateLimitConsumeInput {
  key: string
}

export interface RateLimitDriverInput extends RateLimitConsumeInput {
  limit: number
  name?: string
  windowMs: number
}

export interface RateLimitDriverResult {
  allowed: boolean
  remaining?: number
  resetAt?: number
  retryAfter?: number
  used?: number
}

export interface RateLimitDecision extends RateLimitDriverResult {
  limit: number
  reason?: "limited" | "unavailable"
  windowMs: number
}

export interface RateLimitDriverCapabilities {
  readonly enforcement: RateLimitEnforcement
  readonly metadata: {
    readonly remaining: RateLimitMetadataCapability
    readonly resetAt: RateLimitMetadataCapability
    readonly retryAfter: RateLimitMetadataCapability
    readonly used: RateLimitMetadataCapability
  }
  readonly rejectedAttempts: RateLimitRejectedAttemptBehavior
  readonly scope: RateLimitCounterScope
  readonly windows?: readonly number[]
}

export interface RateLimitDriver {
  capabilities: RateLimitDriverCapabilities
  consume: (input: RateLimitDriverInput) => MaybePromise<RateLimitDriverResult>
  name: string
}

export interface RateLimiter {
  readonly capabilities: RateLimitDriverCapabilities
  consume: (input: RateLimitConsumeInput) => Promise<RateLimitDecision>
  policy: ResolvedRateLimitPolicy
}

export interface CreateRateLimiterOptions extends RateLimitPolicy {
  driver: RateLimitDriver
  name?: string
}

export type ConsumeRateLimitOptions = RateLimitConsumeInput

export type RateLimitProvider = "auto" | "cloudflare" | "memory"

export interface RateLimitModuleOptions {
  provider?: RateLimitProvider
  projectRoot?: string
  scanDirs?: string[]
}

export interface RateLimitRuntimeConfig {
  provider: Exclude<RateLimitProvider, "auto">
}
