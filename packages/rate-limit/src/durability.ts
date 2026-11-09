import type { Durability } from "@vite-hub/runtime/durability"

/** What the build passes to `rateLimitDurability()`. */
export interface RateLimitDurabilityInput {
  provider: string
}

/** The durability of Rate Limit counters. The `memory` provider counts in this process only. */
export function rateLimitDurability(input: RateLimitDurabilityInput): Durability[] {
  if (input.provider !== "memory") {
    return [{ primitive: "rate-limit", store: input.provider, scope: "shared", reason: "Cloudflare Rate Limiting bindings count for every Worker." }]
  }
  return [{
    primitive: "rate-limit",
    store: "memory",
    scope: "process",
    reason: "Counters live in the memory of this process. Each instance counts on its own.",
    fix: "Run one instance. Rate Limit has no shared driver for Node yet.",
  }]
}
