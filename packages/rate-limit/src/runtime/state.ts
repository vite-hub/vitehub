import { AsyncLocalStorage } from "node:async_hooks"

import { getCloudflareEnv, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import type { RateLimiter, RateLimitRuntimeConfig } from "../types.ts"

let runtimeConfig: RateLimitRuntimeConfig = { provider: "memory" }
const runtimeEventStorage = new AsyncLocalStorage<{ event: unknown, requestKey?: string }>()
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

export function enterRateLimitRuntimeEvent(event: unknown, requestKey?: string): void {
  runtimeEventStorage.enterWith({ event, requestKey })
  setActiveCloudflareEnv(getCloudflareEnv(event))
}

export function runWithRateLimitRuntimeEvent<T>(event: unknown, callback: () => T, requestKey?: string): T {
  return runtimeEventStorage.run({ event, requestKey }, () => runWithActiveCloudflareEnv(getCloudflareEnv(event), callback))
}

export function getRateLimitRuntimeEvent(): unknown {
  return runtimeEventStorage.getStore()?.event
}

export function getRateLimitRuntimeRequestKey(): string | undefined {
  return runtimeEventStorage.getStore()?.requestKey
}
