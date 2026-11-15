import { kvRateLimitDriver } from "../drivers/kv.ts"
import { memoryRateLimitDriver } from "../drivers/memory.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"
import { createRateLimiter } from "../limiter.ts"
import { resolveKVRateLimitProvider } from "../internal/kv-provider.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"

import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { RateLimitKVStorage } from "../drivers/kv.ts"
import type { RateLimiter, RateLimitPolicy, RateLimitRuntimeConfig } from "../types.ts"

/** The KV store of the `kv` provider. The generated Nitro plugin passes it from `@vite-hub/kv`. */
export interface RateLimitKVRuntime {
  /** The KV driver that the store uses in this process, for example `getKVStoreDriver()` of `@vite-hub/kv`. */
  driver: () => Promise<string>
  storage: RateLimitKVStorage
  /** The KV store name, for the boot log. */
  store: string
}

let runtimeConfig: RateLimitRuntimeConfig = { provider: "memory" }
let kvRuntime: RateLimitKVRuntime | undefined
let activeProvider: Promise<RateLimitRuntimeConfig["provider"]> | undefined
const runtimeLimiters = new Map<string, Map<string, RateLimiter>>()

/** The counters of this process, or in app tests the counters of the current test. */
function limiters(): Map<string, Map<string, RateLimiter>> {
  const test = getViteHubTestMode()
  return test ? test.backend("rate-limit", () => new Map<string, Map<string, RateLimiter>>()) : runtimeLimiters
}

/** `kv` needs the KV store of the app in `kv`. Other providers ignore it. */
export function setRateLimitRuntimeConfig(config: RateLimitRuntimeConfig, kv?: RateLimitKVRuntime): void {
  runtimeConfig = config
  kvRuntime = kv
  activeProvider = undefined
  runtimeLimiters.clear()
}

/** In app tests, Rate Limit counts in memory for the current test, whatever the host. */
export function getRateLimitRuntimeConfig(): RateLimitRuntimeConfig {
  return getViteHubTestMode() ? { provider: "memory" } : runtimeConfig
}

function requireKVRuntime(): RateLimitKVRuntime {
  if (kvRuntime) return kvRuntime
  throw rateLimitErrorDiagnostics.RATE_LIMIT_R0047({ message: "[vitehub] The kv Rate Limit provider needs KV. Enable KV in the app, or pass a KV store to setRateLimitRuntimeConfig()." })
}

async function resolveKVProvider(kv: RateLimitKVRuntime): Promise<RateLimitRuntimeConfig["provider"]> {
  const driver = await kv.driver()
  if (resolveKVRateLimitProvider(driver) === "kv") {
    console.info(`[vitehub] Rate Limit counts in the KV store "${kv.store}" (${driver}). Every server process that uses this store shares the counts.`)
    return "kv"
  }
  console.warn(`[vitehub] Rate Limit counts in the memory of this process, because the KV store "${kv.store}" uses ${driver}, which has no shared atomic increment. Each server process allows the full limit. Configure a Redis KV store or use a Postgres Database to share the counts.`)
  return "memory"
}

/**
 * The provider that counts in this process. For `kv`, the first call asks KV for its configured driver
 * and prints the choice: `kv` with a shared driver, else `memory`. The generated Nitro plugin calls it at boot.
 */
export async function resolveRateLimitProvider(): Promise<RateLimitRuntimeConfig["provider"]> {
  const { provider } = getRateLimitRuntimeConfig()
  if (provider !== "kv") return provider
  if (activeProvider) return await activeProvider
  const pending = resolveKVProvider(requireKVRuntime())
  activeProvider = pending
  // A failed choice, for example an unknown KV store, fails this call and lets the next call try again.
  void pending.catch(() => {
    if (activeProvider === pending) activeProvider = undefined
  })
  return await pending
}

function policyKey(policy: RateLimitPolicy): string {
  return JSON.stringify([policy.enforcement, policy.failure, policy.limit, normalizeRateLimitPolicy(policy).windowMs])
}

/** The Rate Limiter of one name and policy in this process. `kv` limiters share their counters through KV. */
export function getRuntimeRateLimiter(provider: "kv" | "memory", name: string, policy: RateLimitPolicy): RateLimiter {
  const all = limiters()
  let policies = all.get(name)
  const key = policyKey(policy)
  const existing = policies?.get(key)
  if (existing) return existing

  const driver = provider === "kv" ? kvRateLimitDriver({ storage: requireKVRuntime().storage }) : memoryRateLimitDriver()
  const limiter = createRateLimiter({ ...policy, driver, name })
  if (!policies) {
    policies = new Map()
    all.set(name, policies)
  }
  policies.set(key, limiter)
  return limiter
}

/** Lists each policy used by this name in this process. */
export function listRuntimeRateLimiters(name: string): RateLimiter[] {
  return [...limiters().get(name)?.values() ?? []]
}
