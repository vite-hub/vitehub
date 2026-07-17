import { cloudflareRateLimitDriver } from "../drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { createRateLimiter } from "../limiter.ts"
import {
  getRateLimitLimiterCache,
  getRateLimitRuntimeConfig,
  getRateLimitRuntimeRequestKey,
} from "./state.ts"

import type { RateLimitDecision, RateLimiter, RateLimitPolicy } from "../types.ts"

async function createDefinedRateLimiter(name: string, policy: RateLimitPolicy): Promise<RateLimiter> {
  const { provider } = getRateLimitRuntimeConfig()
  return createRateLimiter({
    ...policy,
    driver: provider === "cloudflare"
      ? cloudflareRateLimitDriver({ name })
      : memoryRateLimitDriver(),
    name,
  })
}

async function getDefinedRateLimiter(name: string, policy: RateLimitPolicy): Promise<RateLimiter> {
  const cache = getRateLimitLimiterCache()
  const cacheKey = JSON.stringify([name, policy.enforcement, policy.failure, policy.limit, policy.window])
  const existing = cache.get(cacheKey)
  if (existing) return await existing
  const pending = createDefinedRateLimiter(name, policy).catch((error) => {
    cache.delete(cacheKey)
    throw error
  })
  cache.set(cacheKey, pending)
  return await pending
}

export async function consumeDefinedRateLimit(name: string, policy: RateLimitPolicy, explicitKey?: string): Promise<RateLimitDecision> {
  const key = explicitKey ?? getRateLimitRuntimeRequestKey()
  if (!key) {
    throw new Error("[vitehub] Rate Limit could not determine a request key. Pass a key outside a request or when limiting by user or tenant.")
  }
  const limiter = await getDefinedRateLimiter(name, policy)
  return await limiter.consume({ key })
}
