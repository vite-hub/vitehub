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
  /** Positive Unix timestamp in milliseconds, at most `8.64e15`. */
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

/** Counter state that a driver reads without consuming a token. */
export interface RateLimitDriverPeekResult {
  /** Positive window-end timestamp in milliseconds, at most `8.64e15`. Omit it when no counter is active. */
  resetAt?: number
  /** Tokens consumed in the current window. `0` when the key has no active counter. */
  used: number
}

export type RateLimitDriverPeekOutcome =
  | [error: null, value: RateLimitDriverPeekResult]
  | [error: Error, value: undefined]

export type RateLimitDriverResetOutcome = [error: Error | null]

export interface RateLimitDriver {
  capabilities: RateLimitDriverCapabilities
  consume: (input: RateLimitDriverInput) => MaybePromise<RateLimitDriverOutcome>
  name: string
  /**
   * Reads the counter of a key without consuming a token. Omit it when the provider cannot read a counter. The
   * Rate Limiter then reports `unsupported`.
   */
  peek?: (input: RateLimitDriverInput) => MaybePromise<RateLimitDriverPeekOutcome>
  /** Deletes the counter of a key. Omit it when the provider cannot reset a counter. */
  reset?: (input: RateLimitDriverInput) => MaybePromise<RateLimitDriverResetOutcome>
}

interface RateLimitPeekBase {
  limit: number
  windowMs: number
}

/** Counter state of one key. `peek()` does not consume a token. */
export type RateLimitPeekResult =
  | (RateLimitPeekBase & { remaining: number, resetAt?: number, status: "known", used: number })
  | (RateLimitPeekBase & { reason: string, status: "unsupported" })
  | (RateLimitPeekBase & { cause: unknown, status: "unavailable" })

export type RateLimitResetResult =
  | { status: "reset" }
  | { reason: string, status: "unsupported" }
  | { cause: unknown, status: "unavailable" }

export interface RateLimiter {
  readonly capabilities: RateLimitDriverCapabilities
  consume: (input: RateLimitConsumeInput) => Promise<RateLimitDecision>
  /** Reads the counter of a key without consuming a token. */
  peek: (input: RateLimitConsumeInput) => Promise<RateLimitPeekResult>
  policy: ResolvedRateLimitPolicy
  /** Deletes the counter of a key, so the next request starts a new window. */
  reset: (input: RateLimitConsumeInput) => Promise<RateLimitResetResult>
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
