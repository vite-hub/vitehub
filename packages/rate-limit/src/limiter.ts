import * as v from "valibot"
import { normalizeRateLimitPolicy } from "./policy.ts"

import type {
  CreateRateLimiterOptions,
  RateLimitConsumeInput,
  RateLimitDecision,
  RateLimitDriverCapabilities,
  RateLimitDriverInput,
  RateLimitDriverResult,
  RateLimiter,
  RateLimitPeekResult,
  ResolvedRateLimitPolicy,
} from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

const driverErrorSchema = v.custom<Error>((value) => {
  const nativeError = "isError" in Error && v.is(v.function(), Error.isError)
    ? Error.isError(value) === true
    : v.is(v.instance(Error), value) || (v.is(v.object({}), value)
        && Object.getPrototypeOf(value) !== Object.prototype
        && Object.getPrototypeOf(value) !== null
        && Object.prototype.toString.call(value) === "[object Error]")
  return nativeError && v.is(v.object({ message: v.string(), name: v.string() }), value)
})

const driverOutcomeSchema = v.pipe(
  v.array(v.unknown()),
  v.length(2),
  v.union([
    v.strictTuple([v.null(), v.unknown()]),
    v.strictTuple([driverErrorSchema, v.undefined()]),
  ]),
)

function resolveDriverCapabilities(options: CreateRateLimiterOptions): RateLimitDriverCapabilities {
  const capabilities = options.driver.capabilities
  if (!capabilities || typeof capabilities !== "object") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0019({ message: `[vitehub] Rate Limit driver "${options.driver.name}" must declare capabilities.` })
  }
  if (capabilities.enforcement !== "best-effort" && capabilities.enforcement !== "strict") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0020({ message: `[vitehub] Rate Limit driver "${options.driver.name}" must declare valid enforcement.` })
  }
  if (capabilities.scope !== "process" && capabilities.scope !== "location" && capabilities.scope !== "global") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0021({ message: `[vitehub] Rate Limit driver "${options.driver.name}" must declare counter scope.` })
  }
  if (capabilities.rejectedAttempts !== "counted" && capabilities.rejectedAttempts !== "not-counted" && capabilities.rejectedAttempts !== "unknown") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0022({ message: `[vitehub] Rate Limit driver "${options.driver.name}" must declare rejected-attempt behavior.` })
  }
  if (capabilities.windows !== undefined && hasInvalidSupportedWindows(capabilities.windows)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0023({ message: `[vitehub] Rate Limit driver "${options.driver.name}" windows must contain positive integer milliseconds.` })
  }
  return {
    enforcement: capabilities.enforcement,
    rejectedAttempts: capabilities.rejectedAttempts,
    scope: capabilities.scope,
    ...(capabilities.windows ? { windows: [...capabilities.windows] } : {}),
  }
}

function hasInvalidSupportedWindows(value: unknown): boolean {
  if (!Array.isArray(value)) return true
  for (let index = 0; index < value.length; index++) {
    const window: unknown = value[index]
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Driver capabilities cross a provider boundary as unknown values.
    if (typeof window !== "number" || !Number.isInteger(window) || window <= 0) return true
  }
  return false
}

function normalizeOptionalInteger(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 0) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0024({ message: `[vitehub] Rate Limit driver result ${label} must be a non-negative integer.` })
  }
  return value
}

function normalizeDriverResult(
  result: RateLimitDriverResult,
  limit: number,
  windowMs: number,
): RateLimitDecision {
  if (!result || typeof result !== "object" || typeof result.allowed !== "boolean") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0025({ message: "[vitehub] Rate Limit driver consume() must return an object with an allowed boolean." })
  }
  const resetAt = result.resetAt
  if (resetAt !== undefined && (!v.is(v.number(), resetAt) || !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > 8.64e15)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0026({ message: "[vitehub] Rate Limit driver result resetAt must be a positive timestamp at most 8640000000000000 milliseconds." })
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
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0027({ message: `[vitehub] Rate Limit driver "${options.driver.name}" provides best-effort enforcement, but this policy requires strict enforcement.` })
  }
  const windows = capabilities.windows
  if (windows?.length && !windows.includes(windowMs)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0028({ message: `[vitehub] Rate Limit driver "${options.driver.name}" does not support a ${windowMs}ms window. Supported windows: ${windows.join(", ")}ms.` })
  }
}

function normalizePeekResult(result: unknown, policy: ResolvedRateLimitPolicy): RateLimitPeekResult {
  if (!v.is(v.object({ resetAt: v.optional(v.unknown()), used: v.pipe(v.number(), v.integer(), v.minValue(0)) }), result)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0037({ message: "[vitehub] Rate Limit driver peek() must return an object with a non-negative integer used count." })
  }
  const resetAt = result.resetAt
  if (resetAt !== undefined && (!v.is(v.number(), resetAt) || !Number.isFinite(resetAt) || resetAt <= 0 || resetAt > 8.64e15)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0037({ message: "[vitehub] Rate Limit driver peek() resetAt must be a positive timestamp at most 8640000000000000 milliseconds." })
  }
  return {
    limit: policy.limit,
    remaining: Math.max(0, policy.limit - result.used),
    ...(resetAt === undefined ? {} : { resetAt }),
    status: "known",
    used: result.used,
    windowMs: policy.windowMs,
  }
}

function unsupportedReason(driverName: string, operation: "peek" | "reset"): string {
  return operation === "peek"
    ? `The "${driverName}" Rate Limit driver cannot read a counter without consuming a token.`
    : `The "${driverName}" Rate Limit driver cannot reset a counter.`
}

function assertKey(input: RateLimitConsumeInput, operation: "peek" | "reset"): void {
  if (!input || !v.is(v.string(), input.key) || input.key.length === 0) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0038({ message: `[vitehub] Rate Limiter ${operation}() requires a non-empty key.` })
  }
}

export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  if (!options.driver || typeof options.driver.consume !== "function") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0029({ message: "[vitehub] createRateLimiter() requires a Rate Limit driver." })
  }
  const policy = normalizeRateLimitPolicy(options)
  const capabilities = resolveDriverCapabilities(options)
  assertDriverSupportsPolicy(options, capabilities, policy.windowMs)

  const driverInput = (input: RateLimitConsumeInput): RateLimitDriverInput => ({
    key: input.key,
    limit: policy.limit,
    name: options.name,
    windowMs: policy.windowMs,
  })

  return {
    capabilities,
    async consume(input) {
      if (!input || !v.is(v.string(), input.key) || input.key.length === 0) {
        throw rateLimitErrorDiagnostics.RATE_LIMIT_R0030({ message: "[vitehub] Rate Limiter consume() requires a non-empty key." })
      }
      const outcome = await options.driver.consume(driverInput(input))
      if (!v.is(driverOutcomeSchema, outcome)) {
        throw rateLimitErrorDiagnostics.RATE_LIMIT_R0044({ message: "[vitehub] Rate Limit driver consume() must return [null, value] or [Error, undefined]." })
      }
      const [error, result] = outcome
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
    async peek(input) {
      assertKey(input, "peek")
      const driver = options.driver
      if (!v.is(v.function(), driver.peek)) {
        return { limit: policy.limit, reason: unsupportedReason(driver.name, "peek"), status: "unsupported", windowMs: policy.windowMs }
      }
      const outcome: unknown = await driver.peek(driverInput(input))
      const parsed = v.safeParse(driverOutcomeSchema, outcome)
      if (!parsed.success) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0043({ message: "[vitehub] Rate Limit driver peek() must return [null, value] or [Error, undefined]." })
      const [error, result] = parsed.output
      if (error) return { cause: error.cause ?? error, limit: policy.limit, status: "unavailable", windowMs: policy.windowMs }
      return normalizePeekResult(result, policy)
    },
    policy,
    async reset(input) {
      assertKey(input, "reset")
      const driver = options.driver
      if (!v.is(v.function(), driver.reset)) {
        return { reason: unsupportedReason(driver.name, "reset"), status: "unsupported" }
      }
      const outcome: unknown = await driver.reset(driverInput(input))
      const parsed = v.safeParse(v.strictTuple([v.nullable(driverErrorSchema)]), outcome)
      if (!parsed.success) throw rateLimitErrorDiagnostics.RATE_LIMIT_R0042({ message: "[vitehub] Rate Limit driver reset() must return [null] or [Error]." })
      const [error] = parsed.output
      return error ? { cause: error.cause ?? error, status: "unavailable" } : { status: "reset" }
    },
  }
}
