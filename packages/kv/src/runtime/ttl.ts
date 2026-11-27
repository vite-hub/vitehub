import { parseDuration } from "@vite-hub/runtime"

import type { Duration } from "@vite-hub/runtime"

/**
 * The seconds of a KV `ttl`: a number of seconds, or a duration such as `"1h"`. `undefined` when it is not a positive
 * time, so the caller returns `KV_INVALID_TTL`.
 */
export function ttlSeconds(ttl: unknown): number | undefined {
  let seconds: number
  if (typeof ttl === "number") seconds = ttl
  else if (typeof ttl !== "string") return
  else {
    try {
      // SAFETY: parseDuration() checks the text at runtime.
      seconds = parseDuration(ttl as Duration) / 1000
    }
    catch {
      return
    }
  }
  return Number.isFinite(seconds) && seconds > 0 && Number.isSafeInteger(Math.ceil(seconds * 1000)) ? seconds : undefined
}
