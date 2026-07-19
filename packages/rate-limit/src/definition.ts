import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"
import { consumeDefinedRateLimit, enforceDefinedRateLimit } from "./runtime/client.ts"

import type { RateLimitHandle, RateLimitPolicy } from "./types.ts"

export function defineRateLimit(name: string, policy: RateLimitPolicy): RateLimitHandle {
  const id = typeof name === "string" ? name.trim() : ""
  if (!id) {
    throw new TypeError("`defineRateLimit()` requires a non-empty stable ID.")
  }
  const normalized = Object.freeze(normalizeRateLimitPolicy(policy))
  const unknownKey = Object.keys(policy).find(key => !rateLimitPolicyKeys.has(key))
  if (unknownKey) {
    throw new TypeError(`\`defineRateLimit()\` does not support the "${unknownKey}" option.`)
  }

  const declaredPolicy = declaredRateLimitPolicy(normalized)

  return Object.freeze({
    consume: async (key?: string) => await consumeDefinedRateLimit(id, declaredPolicy, key),
    enforce: async (key?: string) => await enforceDefinedRateLimit(id, declaredPolicy, key),
    id,
    kind: "rate-limit-handle" as const,
    policy: normalized,
  })
}
