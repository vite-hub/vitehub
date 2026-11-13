import type { RateLimitDriver, RateLimitDriverInput } from "../types.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"

/** `[error, data]`, as KV operations return it. */
type KVOperationResult<T> = readonly [error: Error, data: undefined] | readonly [error: undefined | null, data: T]

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
    timer = setTimeout(() => resolve([new Error("[vitehub] Rate Limit KV operation timed out after 1000 milliseconds."), undefined]), 1_000)
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
  return { key, resetAt, start }
}

/**
 * Counts fixed windows in a KV store with one atomic `increment` for each request. Every server process that uses the
 * same store shares the counters. Rejected requests also increment the counter.
 */
export function kvRateLimitDriver(options: KVRateLimitDriverOptions): KVRateLimitDriver {
  if (!isStorage(options?.storage)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0046({ message: "[vitehub] kvRateLimitDriver() requires a KV store with increment(), get(), and delete()." })
  }
  const storage = options.storage
  const now = options.now ?? Date.now

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
      const [error, used] = await withKVDeadline(storage.increment(window.key, input.windowMs / 1_000))
      if (error) return [error, undefined]
      if (used > input.limit) {
        return [null, {
          allowed: false,
          remaining: 0,
          resetAt: window.resetAt,
          retryAfter: Math.max(1, Math.ceil((window.resetAt - timestamp) / 1_000)),
          used,
        }]
      }
      return [null, { allowed: true, remaining: input.limit - used, resetAt: window.resetAt, used }]
    },
    name: "kv",
    async peek(input) {
      const window = fixedWindow(input, now())
      const [error, value] = await withKVDeadline(storage.get(window.key))
      if (error) return [error, undefined]
      const used = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0
      return [null, { resetAt: used ? window.resetAt : undefined, used }]
    },
    async reset(input) {
      const [error] = await withKVDeadline(storage.delete(fixedWindow(input, now()).key))
      return [error ?? null]
    },
  }
}
