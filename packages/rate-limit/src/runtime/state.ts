import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { createRateLimiter } from "../limiter.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"

import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { RateLimiter, RateLimitPolicy, RateLimitRuntimeConfig } from "../types.ts"

let runtimeConfig: RateLimitRuntimeConfig = { driver: "memory" }
const runtimeMemoryLimiters = new Map<string, Map<string, RateLimiter>>()

/** The memory counters of this process, or in app tests the counters of the current test. */
function memoryLimiters(): Map<string, Map<string, RateLimiter>> {
  const test = getViteHubTestMode()
  return test ? test.backend("rate-limit", () => new Map<string, Map<string, RateLimiter>>()) : runtimeMemoryLimiters
}

export function setRateLimitRuntimeConfig(config: RateLimitRuntimeConfig): void {
  runtimeConfig = config
  runtimeMemoryLimiters.clear()
}

/** In app tests, Rate Limit counts in memory for the current test, whatever the host. */
export function getRateLimitRuntimeConfig(): RateLimitRuntimeConfig {
  return getViteHubTestMode() ? { driver: "memory" } : runtimeConfig
}

function normalizeRateLimitWindowKey(policy: RateLimitPolicy): number {
  return normalizeRateLimitPolicy(policy).windowMs
}

export function getMemoryRateLimiter(name: string, policy: RateLimitPolicy): RateLimiter {
  const limiters = memoryLimiters()
  let policies = limiters.get(name)
  const policyKey = JSON.stringify([policy.enforcement, policy.failure, policy.limit, normalizeRateLimitWindowKey(policy)])
  const existing = policies?.get(policyKey)
  if (existing) return existing

  const limiter = createRateLimiter({ ...policy, driver: memoryRateLimitDriver(), name })
  if (!policies) {
    policies = new Map()
    limiters.set(name, policies)
  }
  policies.set(policyKey, limiter)
  return limiter
}

/** Lists each policy used by this name in the current runtime configuration. */
export function listMemoryRateLimiters(name: string): RateLimiter[] {
  return [...memoryLimiters().get(name)?.values() ?? []]
}
