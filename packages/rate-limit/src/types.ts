type MaybePromise<T> = Promise<T> | T

export type RateLimitWindow =
  | `${number}ms`
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`

export type RateLimitEnforcement = "best-effort" | "strict"
export type RateLimitFailurePolicy = "allow" | "deny"
export type RateLimitCounterScope = "global" | "location" | "process"
export type RateLimitRejectedAttemptBehavior = "counted" | "not-counted" | "unknown"

export interface RateLimitPolicy {
  enforcement?: RateLimitEnforcement
  failure?: RateLimitFailurePolicy
  limit: number
  window: RateLimitWindow
}

export interface RequireRateLimitOptions extends RateLimitPolicy {
  key?: string
}

export interface RateLimitRequestEvent {
  readonly req: {
    readonly headers: { get: (name: string) => string | null }
  }
}

export interface ResolvedRateLimitPolicy {
  readonly enforcement: RateLimitEnforcement
  readonly failure: RateLimitFailurePolicy
  readonly limit: number
  readonly window: RateLimitWindow
  readonly windowMs: number
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

export type RateLimitDriverOutcome =
  | [error: null, value: RateLimitDriverResult]
  | [error: Error, value: undefined]

interface RateLimitDecisionBase extends RateLimitDriverResult {
  limit: number
  windowMs: number
}

interface RateLimitAllowedDecision extends RateLimitDecisionBase {
  allowed: true
  cause?: never
  reason?: never
}

interface RateLimitLimitedDecision extends RateLimitDecisionBase {
  allowed: false
  cause?: never
  reason: "limited"
}

interface RateLimitUnavailableDecision extends RateLimitDecisionBase {
  cause: unknown
  reason: "unavailable"
}

export type RateLimitDecision = RateLimitAllowedDecision | RateLimitLimitedDecision | RateLimitUnavailableDecision

export interface RateLimitDriverCapabilities {
  readonly enforcement: RateLimitEnforcement
  readonly rejectedAttempts: RateLimitRejectedAttemptBehavior
  readonly scope: RateLimitCounterScope
  readonly windows?: readonly number[]
}

export interface RateLimitDriver {
  capabilities: RateLimitDriverCapabilities
  consume: (input: RateLimitDriverInput) => MaybePromise<RateLimitDriverOutcome>
  name: string
}

export interface RateLimiter {
  readonly capabilities: RateLimitDriverCapabilities
  consume: (input: RateLimitConsumeInput) => Promise<RateLimitDecision>
  policy: ResolvedRateLimitPolicy
}

export interface RateLimitDeclaration {
  name: string
  policy: RateLimitPolicy
  source: {
    column: number
    file: string
    line: number
  }
}

export interface CreateRateLimiterOptions extends RateLimitPolicy {
  driver: RateLimitDriver
  name?: string
}

export type RateLimitProvider = "auto" | "cloudflare" | "memory"

export interface RateLimitModuleOptions {
  namespace?: string
  provider?: RateLimitProvider
  projectRoot?: string
  scanDirs?: string[]
}

export interface RateLimitRuntimeConfig {
  provider: Exclude<RateLimitProvider, "auto">
}
