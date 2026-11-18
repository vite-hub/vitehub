import { toResultError } from "@vite-hub/runtime"

import type { Result } from "@vite-hub/runtime"
import type { RateLimitDriver, RateLimitDriverInput } from "../types.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"

/** `[error, data]`, as KV operations return it. */
type KVOperationResult<T> = Result<T>

/**
 * The KV operations that the driver uses. `kv` and `kv.store(name)` from `@vite-hub/kv` match it. `increment` must be
 * atomic and set the TTL with the first increment, as the `redis`, `database`, and `upstash` drivers do.
 */
export interface RateLimitKVStorage {
  delete: (key: string) => Promise<KVOperationResult<void>>
  get: (key: string) => Promise<KVOperationResult<unknown>>
  increment: (key: string, ttl: number) => Promise<KVOperationResult<number>>
}

export interface KVRateLimitDriverOptions {
  now?: () => number
  storage: RateLimitKVStorage
}

export interface KVRateLimitDriver extends RateLimitDriver {
  peek: NonNullable<RateLimitDriver["peek"]>
  refund: NonNullable<RateLimitDriver["refund"]>
  reset: NonNullable<RateLimitDriver["reset"]>
}

function isStorage(value: unknown): value is RateLimitKVStorage {
  if (!value || typeof value !== "object") return false
  return typeof Reflect.get(value, "increment") === "function"
    && typeof Reflect.get(value, "get") === "function"
    && typeof Reflect.get(value, "delete") === "function"
}

/** Bound the request wait without hiding configuration errors thrown by KV. */
async function withKVDeadline<T>(operation: Promise<KVOperationResult<T>>): Promise<KVOperationResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<KVOperationResult<T>>((resolve) => {
    timer = setTimeout(() => resolve([toResultError(rateLimitErrorDiagnostics.RATE_LIMIT_KV_TIMEOUT()), undefined]), 1_000)
  })
  try {
    return await Promise.race([operation, deadline])
  }
  finally {
    clearTimeout(timer)
  }
}

interface FixedWindow {
  key: string
  /** Counts the requests that `refund()` gave back in this window. */
  refundKey: string
  resetAt: number
  start: number
}

/**
 * KV keys use `/` and `:` as separators and reject a `.` or `..` segment, so encode the parts that come from the app.
 * Without it, a client key such as `..` makes every increment fail, and `failure: "allow"` then lets it through.
 */
function keySegment(value: string): string {
  return encodeURIComponent(value).replaceAll(".", "%2E")
}

/**
 * One counter for each Rate Limit, window duration, key, and window start. A new window uses a new key, so no reset is
 * necessary. The duration keeps a `1m` and a `1h` limiter of one name apart when their window starts align.
 */
function fixedWindow(input: RateLimitDriverInput, timestamp: number): FixedWindow {
  const start = Math.floor(timestamp / input.windowMs) * input.windowMs
  const resetAt = start + input.windowMs
  if (!Number.isFinite(resetAt) || resetAt <= 0 || resetAt > 8.64e15) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0045({ message: "[vitehub] KV Rate Limit fixed-window end must be a positive timestamp at most 8640000000000000 milliseconds." })
  }
  const key = `rate-limit:${keySegment(input.name ?? "default")}:${input.windowMs}:${keySegment(input.key)}:${start}`
  return { key, refundKey: `${key}:refunds`, resetAt, start }
}

function storedCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0
}

/**
 * Counts fixed windows in a KV store with one atomic `increment` for each request. Every server process that uses the
 * same store shares the counters. Rejected requests also increment the counter. KV has no atomic decrement, so
 * `refund()` increments a second counter, and `consume()` reads it only when the first counter passes the limit.
 */
export function kvRateLimitDriver(options: KVRateLimitDriverOptions): KVRateLimitDriver {
  if (!isStorage(options?.storage)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0046({ message: "[vitehub] kvRateLimitDriver() requires a KV store with increment(), get(), and delete()." })
  }
  const storage = options.storage
  const now = options.now ?? Date.now

  async function readCounts(window: FixedWindow): Promise<KVOperationResult<{ count: number, refunds: number }>> {
    const [[countError, count], [refundsError, refunds]] = await Promise.all([
      withKVDeadline(storage.get(window.key)),
      withKVDeadline(storage.get(window.refundKey)),
    ])
    const error = countError ?? refundsError
    if (error) return [error, undefined]
    return [undefined, { count: storedCount(count), refunds: storedCount(refunds) }]
  }

  return {
    capabilities: {
      enforcement: "strict",
      rejectedAttempts: "counted",
      scope: "global",
    },
    async consume(input) {
      const timestamp = now()
      const window = fixedWindow(input, timestamp)
      // The key expires one window after the first request, so old windows do not stay in the store.
      const [error, count] = await withKVDeadline(storage.increment(window.key, input.windowMs / 1_000))
      if (error) return [error, undefined]
      let used = count
      if (count > input.limit) {
        const [refundsError, refunds] = await withKVDeadline(storage.get(window.refundKey))
        if (refundsError) return [refundsError, undefined]
        used = count - storedCount(refunds)
      }
      if (used > input.limit) {
        return [undefined, {
          allowed: false,
          remaining: 0,
          resetAt: window.resetAt,
          retryAfter: Math.max(1, Math.ceil((window.resetAt - timestamp) / 1_000)),
          used,
        }]
      }
      return [undefined, { allowed: true, remaining: input.limit - used, resetAt: window.resetAt, used }]
    },
    name: "kv",
    async peek(input) {
      const window = fixedWindow(input, now())
      const [error, counts] = await readCounts(window)
      if (error) return [error, undefined]
      const used = Math.max(0, counts.count - counts.refunds)
      return [undefined, { resetAt: counts.count ? window.resetAt : undefined, used }]
    },
    async refund(input) {
      const window = fixedWindow(input, now())
      const [error, counts] = await readCounts(window)
      if (error) return [error, undefined]
      // Nothing to give back. Two refunds at the same time can both pass this check, which gives back one more.
      if (counts.count <= counts.refunds) return [undefined, undefined]
      const [refundError] = await withKVDeadline(storage.increment(window.refundKey, input.windowMs / 1_000))
      return refundError ? [refundError, undefined] : [undefined, undefined]
    },
    async reset(input) {
      const window = fixedWindow(input, now())
      // Refunds go first, so a failed delete never leaves refunds without the requests that they give back.
      for (const key of [window.refundKey, window.key]) {
        const [error] = await withKVDeadline(storage.delete(key))
        if (error) return [error, undefined]
      }
      return [undefined, undefined]
    },
  }
}
