import { AsyncLocalStorage } from "node:async_hooks"

import { getCloudflareEnv, runWithActiveCloudflareEnv, setActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import type { RateLimitDefinition, RateLimitDefinitionRegistry, RateLimiter, RateLimitRuntimeConfig } from "../types.ts"

let runtimeConfig: RateLimitRuntimeConfig = { provider: "memory" }
let runtimeRegistry: RateLimitDefinitionRegistry | undefined
const runtimeEventStorage = new AsyncLocalStorage<unknown>()
const limiterCache = new Map<string, Promise<RateLimiter>>()

export function setRateLimitRuntimeConfig(config: RateLimitRuntimeConfig): void {
  runtimeConfig = config
  limiterCache.clear()
}

export function getRateLimitRuntimeConfig(): RateLimitRuntimeConfig {
  return runtimeConfig
}

export function setRateLimitRuntimeRegistry(registry: RateLimitDefinitionRegistry | undefined): void {
  runtimeRegistry = registry
  limiterCache.clear()
}

export function getRateLimitLimiterCache(): Map<string, Promise<RateLimiter>> {
  return limiterCache
}

export function enterRateLimitRuntimeEvent(event: unknown): void {
  runtimeEventStorage.enterWith(event)
  setActiveCloudflareEnv(getCloudflareEnv(event))
}

export function runWithRateLimitRuntimeEvent<T>(event: unknown, callback: () => T): T {
  return runtimeEventStorage.run(event, () => runWithActiveCloudflareEnv(getCloudflareEnv(event), callback))
}

export function getRateLimitRuntimeEvent(): unknown {
  return runtimeEventStorage.getStore()
}

function isDefinition(value: unknown): value is RateLimitDefinition {
  return Boolean(value)
    && typeof value === "object"
    && Number.isInteger((value as RateLimitDefinition).limit)
    && typeof (value as RateLimitDefinition).window === "string"
}

export async function loadRateLimitDefinition(name: string): Promise<RateLimitDefinition | undefined> {
  const load = runtimeRegistry?.[name]
  if (!load) return
  const loaded = await load()
  if (isDefinition(loaded)) return loaded
  if (loaded && typeof loaded === "object" && "default" in loaded && isDefinition(loaded.default)) {
    return loaded.default
  }
}
