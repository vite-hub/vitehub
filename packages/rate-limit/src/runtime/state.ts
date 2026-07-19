import { AsyncLocalStorage } from "node:async_hooks"

import { getCloudflareEnv, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import type { RateLimiter, RateLimitRuntimeConfig } from "../types.ts"

let runtimeConfig: RateLimitRuntimeConfig = { provider: "memory" }
let fallbackRuntimeEvent: unknown
let fallbackRuntimeRequestKey: string | undefined
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
  fallbackRuntimeEvent = event
  fallbackRuntimeRequestKey = requestKey
  try {
    runtimeEventStorage.enterWith({ event, requestKey })
  }
  catch {}
  setActiveCloudflareEnv(getCloudflareEnv(event))
}

export function runWithRateLimitRuntimeEvent<T>(event: unknown, callback: () => T, requestKey?: string): T {
  return runtimeEventStorage.run({ event, requestKey }, () => runWithActiveCloudflareEnv(getCloudflareEnv(event), callback))
}

export function getRateLimitRuntimeEvent(): unknown {
  const store = runtimeEventStorage.getStore()
  return store ? store.event : fallbackRuntimeEvent
}

export function getRateLimitRuntimeRequestKey(): string | undefined {
  const store = runtimeEventStorage.getStore()
  return store ? store.requestKey : fallbackRuntimeRequestKey
}
