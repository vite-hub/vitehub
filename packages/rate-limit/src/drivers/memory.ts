import type { RateLimitDriver } from "../types.ts"

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
  size: () => number
}

const defaultMaxEntries = 100_000

export function memoryRateLimitDriver(options: MemoryRateLimitDriverOptions = {}): MemoryRateLimitDriver {
  const entries = new Map<string, MemoryEntry>()
  const maxEntries = options.maxEntries ?? defaultMaxEntries
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError("[vitehub] Memory Rate Limit driver maxEntries must be a positive integer.")
  }
  const now = options.now ?? Date.now

  function prune(timestamp: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= timestamp) entries.delete(key)
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
    },
    consume(input) {
      const timestamp = now()
      prune(timestamp)
      const key = `${input.name ?? "default"}\0${input.key}`
      const resetAt = Math.floor(timestamp / input.windowMs) * input.windowMs + input.windowMs
      const current = entries.get(key)
      if (!current && entries.size >= maxEntries) {
        throw new Error(`[vitehub] Memory Rate Limit driver reached maxEntries (${maxEntries}) while active counters remain.`)
      }
      const entry = current && current.resetAt > timestamp ? current : { count: 0, resetAt }
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
      return [null, {
        allowed: true,
        remaining: input.limit - entry.count,
        resetAt: entry.resetAt,
        used: entry.count,
      }]
    },
    name: "memory",
    size() {
      return entries.size
    },
  }
}
