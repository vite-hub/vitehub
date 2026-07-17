import { normalizeRateLimitPolicy } from "./policy.ts"

import type { RateLimitDefinition, RateLimitPolicy } from "./types.ts"

const definitionKeys = new Set(["enforcement", "failure", "limit", "window"])

export function defineRateLimit(policy: RateLimitPolicy): RateLimitDefinition {
  const normalized = normalizeRateLimitPolicy(policy)
  const unknownKey = Object.keys(policy).find(key => !definitionKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineRateLimit()\` does not support the "${unknownKey}" option.`)
  }

  return {
    enforcement: normalized.enforcement,
    failure: normalized.failure,
    limit: normalized.limit,
    window: normalized.window,
  }
}
