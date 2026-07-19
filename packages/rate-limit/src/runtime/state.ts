import type { RateLimiter, RateLimitRuntimeConfig } from "../types.ts"

let runtimeConfig: RateLimitRuntimeConfig = { provider: "memory" }
const limiterCache = new Map<string, Promise<RateLimiter>>()

export function setRateLimitRuntimeConfig(config: RateLimitRuntimeConfig): void {
  runtimeConfig = config
  limiterCache.clear()
}

export function getRateLimitRuntimeConfig(): RateLimitRuntimeConfig {
  return runtimeConfig
}

export function getRateLimitLimiterCache(): Map<string, Promise<RateLimiter>> {
  return limiterCache
}
