import { cloudflareRateLimitDriver } from "../drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { createRateLimiter } from "../limiter.ts"
import {
  getRateLimitLimiterCache,
  getRateLimitRuntimeConfig,
  loadRateLimitDefinition,
} from "./state.ts"

import type { ConsumeRateLimitOptions, RateLimitDecision, RateLimiter } from "../types.ts"

async function createNamedRateLimiter(name: string): Promise<RateLimiter> {
  const definition = await loadRateLimitDefinition(name)
  if (!definition) {
    throw new Error(`Unknown Rate Limit Definition: ${name}. The Rate Limit Runtime Registry is installed by ViteHub; direct scripts should use createRateLimiter().`)
  }
  const { provider } = getRateLimitRuntimeConfig()
  return createRateLimiter({
    ...definition,
    driver: provider === "cloudflare"
      ? cloudflareRateLimitDriver({ name })
      : memoryRateLimitDriver(),
    name,
  })
}

export async function getRateLimit(name: string): Promise<RateLimiter> {
  const cache = getRateLimitLimiterCache()
  const existing = cache.get(name)
  if (existing) return await existing
  const pending = createNamedRateLimiter(name).catch((error) => {
    cache.delete(name)
    throw error
  })
  cache.set(name, pending)
  return await pending
}

export async function consumeRateLimit(name: string, options: ConsumeRateLimitOptions): Promise<RateLimitDecision> {
  const limiter = await getRateLimit(name)
  return await limiter.consume(options)
}
