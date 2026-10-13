import type { RateLimitDriver } from "../types.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"

interface MemoryEntry {
  count: number
  resetAt: number
}

export interface MemoryRateLimitDriverOptions {
  maxEntries?: number
  now?: () => number
}

export interface MemoryRateLimitDriver extends RateLimitDriver {
  clear: () => void
  peek: NonNullable<RateLimitDriver["peek"]>
  reset: NonNullable<RateLimitDriver["reset"]>
  size: () => number
}

const defaultMaxEntries = 100_000

export function memoryRateLimitDriver(options: MemoryRateLimitDriverOptions = {}): MemoryRateLimitDriver {
  const entries = new Map<string, MemoryEntry>()
  let nextExpiry = Number.POSITIVE_INFINITY
  const maxEntries = options.maxEntries ?? defaultMaxEntries
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0007({ message: "[vitehub] Memory Rate Limit driver maxEntries must be a positive integer." })
  }
  const now = options.now ?? Date.now

  function prune(timestamp: number): void {
    if (timestamp < nextExpiry) return
    nextExpiry = Number.POSITIVE_INFINITY
    for (const [key, entry] of entries) {
      if (entry.resetAt <= timestamp) entries.delete(key)
      else nextExpiry = Math.min(nextExpiry, entry.resetAt)
    }
  }

  return {
    capabilities: {
      enforcement: "strict",
      rejectedAttempts: "not-counted",
      scope: "process",
    },
    clear() {
      entries.clear()
      nextExpiry = Number.POSITIVE_INFINITY
    },
    consume(input) {
      const timestamp = now()
      prune(timestamp)
      const key = JSON.stringify([input.name ?? "default", input.key])
      const current = entries.get(key)
      if (!current && entries.size >= maxEntries) {
        throw rateLimitErrorDiagnostics.RATE_LIMIT_R0008({ message: `[vitehub] Memory Rate Limit driver reached maxEntries (${maxEntries}) while active counters remain.` })
      }
      let entry = current
      if (!entry || entry.resetAt <= timestamp) {
        const resetAt = Math.floor(timestamp / input.windowMs) * input.windowMs + input.windowMs
        if (!Number.isFinite(resetAt) || resetAt <= 0 || resetAt > 8.64e15) {
          throw rateLimitErrorDiagnostics.RATE_LIMIT_R0045({ message: "[vitehub] Memory Rate Limit fixed-window end must be a positive timestamp at most 8640000000000000 milliseconds." })
        }
        entry = { count: 0, resetAt }
      }
      if (entry.count >= input.limit) {
        return [null, {
          allowed: false,
          remaining: 0,
          resetAt: entry.resetAt,
          retryAfter: Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1_000)),
          used: entry.count,
        }]
      }
      entry.count += 1
      entries.set(key, entry)
      nextExpiry = Math.min(nextExpiry, entry.resetAt)
      return [null, {
        allowed: true,
        remaining: input.limit - entry.count,
        resetAt: entry.resetAt,
        used: entry.count,
      }]
    },
    peek(input) {
      const timestamp = now()
      prune(timestamp)
      const key = JSON.stringify([input.name ?? "default", input.key])
      const entry = entries.get(key)
      return [null, { resetAt: entry && entry.resetAt > timestamp ? entry.resetAt : undefined, used: entry && entry.resetAt > timestamp ? entry.count : 0 }]
    },
    name: "memory",
    reset(input) {
      const key = JSON.stringify([input.name ?? "default", input.key])
      entries.delete(key)
      return [null]
    },
    size() {
      return entries.size
    },
  }
}
