import { getRequestIP, HTTPError } from "h3"

import { cloudflareRateLimitDriver } from "./drivers/cloudflare.ts"
import { memoryRateLimitDriver } from "./drivers/memory.ts"
import { getCloudflareRateLimitBindingName } from "./integrations/cloudflare.ts"
import { createRateLimiter } from "./limiter.ts"
import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"
import {
  getRateLimitLimiterCache,
  getRateLimitRuntimeConfig,
} from "./runtime/state.ts"

import type { HTTPEvent } from "h3"
import type { CloudflareRateLimitBinding } from "./drivers/cloudflare.ts"
import type { RateLimiter, RateLimitPolicy, RateLimitRequestEvent, RequireRateLimitOptions } from "./types.ts"

interface CloudflareEnvCarrier {
  context?: { cloudflare?: { env?: Record<string, unknown> }, _platform?: { cloudflare?: { env?: Record<string, unknown> } } }
  env?: Record<string, unknown>
  node?: { req?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } } }
  req?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } }
}

const guardOptionKeys = new Set([...rateLimitPolicyKeys, "key"])

function getCloudflareEventEnv(event: RateLimitRequestEvent): Record<string, unknown> | undefined {
  const target = event as unknown as CloudflareEnvCarrier
  return target.env
    ?? target.context?.cloudflare?.env
    ?? target.context?._platform?.cloudflare?.env
    ?? target.req?.runtime?.cloudflare?.env
    ?? target.node?.req?.runtime?.cloudflare?.env
}

function isCloudflareBinding(value: unknown): value is CloudflareRateLimitBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as CloudflareRateLimitBinding).limit === "function"
}

function getRequestKey(event: RateLimitRequestEvent, provider: "cloudflare" | "memory"): string | undefined {
  return provider === "cloudflare"
    ? event.req.headers.get("cf-connecting-ip") || getRequestIP(event as HTTPEvent)
    : getRequestIP(event as HTTPEvent)
}

function getMemoryRateLimiter(name: string, policy: RateLimitPolicy): Promise<RateLimiter> {
  const cache = getRateLimitLimiterCache()
  const cacheKey = JSON.stringify([name, policy.enforcement, policy.failure, policy.limit, policy.window])
  const existing = cache.get(cacheKey)
  if (existing) return existing
  const pending = Promise.resolve(createRateLimiter({
    ...policy,
    driver: memoryRateLimitDriver(),
    name,
  })).catch((error) => {
    cache.delete(cacheKey)
    throw error
  })
  cache.set(cacheKey, pending)
  return pending
}

function getCloudflareRateLimiter(event: RateLimitRequestEvent, name: string, policy: RateLimitPolicy): RateLimiter {
  const bindingName = getCloudflareRateLimitBindingName(name)
  const binding = getCloudflareEventEnv(event)?.[bindingName]
  if (!isCloudflareBinding(binding)) {
    throw new Error(`[vitehub] Cloudflare Rate Limit binding "${bindingName}" was not found on the request event.`)
  }
  return createRateLimiter({
    ...policy,
    driver: cloudflareRateLimitDriver({ binding }),
    name,
  })
}

export async function requireRateLimit(event: RateLimitRequestEvent, name: string, options: RequireRateLimitOptions): Promise<void> {
  const id = typeof name === "string" ? name.trim() : ""
  if (!id) {
    throw new TypeError("`requireRateLimit()` requires a non-empty stable ID.")
  }
  const unknownKey = options && typeof options === "object" && !Array.isArray(options)
    ? Object.keys(options).find(key => !guardOptionKeys.has(key))
    : undefined
  if (unknownKey) {
    throw new TypeError(`\`requireRateLimit()\` does not support the "${unknownKey}" option.`)
  }
  if (options?.key !== undefined && (typeof options.key !== "string" || options.key.length === 0)) {
    throw new TypeError("`requireRateLimit()` key must be a non-empty string.")
  }

  const policy = declaredRateLimitPolicy(normalizeRateLimitPolicy(options))
  const { provider } = getRateLimitRuntimeConfig()
  const key = options.key ?? getRequestKey(event, provider)
  if (!key) {
    throw new Error("[vitehub] Rate Limit could not determine a request key. Pass key when limiting by user or tenant or when the request has no client address.")
  }
  const limiter = provider === "cloudflare"
    ? getCloudflareRateLimiter(event, id, policy)
    : await getMemoryRateLimiter(id, policy)
  const decision = await limiter.consume({ key })
  if (decision.allowed) return

  if (decision.reason === "unavailable") {
    throw new HTTPError({
      cause: decision.cause,
      message: "Rate limiting is unavailable.",
      status: 503,
      statusText: "Service Unavailable",
    })
  }

  throw new HTTPError({
    headers: decision.retryAfter === undefined
      ? undefined
      : { "Retry-After": String(decision.retryAfter) },
    message: "Rate limit exceeded.",
    status: 429,
    statusText: "Too Many Requests",
  })
}
