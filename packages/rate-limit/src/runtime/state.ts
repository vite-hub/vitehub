import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { createRateLimiter } from "../limiter.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"

import type { RateLimiter, RateLimitPolicy, RateLimitRuntimeConfig } from "../types.ts"

let runtimeConfig: RateLimitRuntimeConfig = { provider: "memory" }
const memoryLimiters = new Map<string, Map<string, RateLimiter>>()

export function setRateLimitRuntimeConfig(config: RateLimitRuntimeConfig): void {
  runtimeConfig = config
  memoryLimiters.clear()
}

export function getRateLimitRuntimeConfig(): RateLimitRuntimeConfig {
  return runtimeConfig
}

function normalizeRateLimitWindowKey(policy: RateLimitPolicy): number {
  return normalizeRateLimitPolicy(policy).windowMs
}

export function getMemoryRateLimiter(name: string, policy: RateLimitPolicy): RateLimiter {
  let policies = memoryLimiters.get(name)
  const policyKey = JSON.stringify([policy.enforcement, policy.failure, policy.limit, normalizeRateLimitWindowKey(policy)])
  const existing = policies?.get(policyKey)
  if (existing) return existing

  const limiter = createRateLimiter({ ...policy, driver: memoryRateLimitDriver(), name })
  if (!policies) {
    policies = new Map()
    memoryLimiters.set(name, policies)
  }
  policies.set(policyKey, limiter)
  return limiter
}

/** Lists each policy used by this name in the current runtime configuration. */
export function listMemoryRateLimiters(name: string): RateLimiter[] {
  return [...memoryLimiters.get(name)?.values() ?? []]
}
