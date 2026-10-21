import { getRequestIP, HTTPError } from "h3"
import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { cloudflareRateLimitDriver } from "./drivers/cloudflare.ts"
import { getCloudflareRateLimitBindingName } from "./integrations/cloudflare.ts"
import { createRateLimiter } from "./limiter.ts"
import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"
import {
  getMemoryRateLimiter,
  getRateLimitRuntimeConfig,
} from "./runtime/state.ts"

import type { HTTPEvent } from "h3"
import type { CloudflareRateLimitBinding } from "./drivers/cloudflare.ts"
import type { RateLimiter, RateLimitPolicy, RateLimitRequestEvent, RequireRateLimitOptions } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

const guardOptionKeys = new Set([...rateLimitPolicyKeys, "key"])

function getCloudflareEventEnv(event: RateLimitRequestEvent): Record<string, unknown> | undefined {
  return getCloudflareEnv(event, { fallback: false })
}

function isCloudflareBinding(value: unknown): value is CloudflareRateLimitBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as CloudflareRateLimitBinding).limit === "function"
}

function getRequestKey(event: RateLimitRequestEvent, provider: "cloudflare" | "memory"): string | undefined {
  return provider === "cloudflare"
    ? event.req.headers.get("cf-connecting-ip") || getRequestIP(event as HTTPEvent)
    : getRequestIP(event as HTTPEvent)
}

function getCloudflareRateLimiter(event: RateLimitRequestEvent, name: string, policy: RateLimitPolicy): RateLimiter {
  const bindingName = getCloudflareRateLimitBindingName(name)
  const binding = getCloudflareEventEnv(event)?.[bindingName]
  if (!isCloudflareBinding(binding)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0009({ message: `[vitehub] Cloudflare Rate Limit binding "${bindingName}" was not found on the request event.` })
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
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0010({ message: "`requireRateLimit()` requires a non-empty stable ID." })
  }
  const unknownKey = options && typeof options === "object" && !Array.isArray(options)
    ? Object.keys(options).find(key => !guardOptionKeys.has(key))
    : undefined
  if (unknownKey) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0011({ message: `\`requireRateLimit()\` does not support the "${unknownKey}" option.` })
  }
  if (options?.key !== undefined && (typeof options.key !== "string" || options.key.length === 0)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0012({ message: "`requireRateLimit()` key must be a non-empty string." })
  }

  const policy = declaredRateLimitPolicy(normalizeRateLimitPolicy(options))
  const { provider } = getRateLimitRuntimeConfig()
  const key = options.key ?? getRequestKey(event, provider)
  if (!key) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0013({ message: "[vitehub] Rate Limit could not determine a request key. Pass key when limiting by user or tenant or when the request has no client address." })
  }
  const limiter = provider === "cloudflare"
    ? getCloudflareRateLimiter(event, id, policy)
    : getMemoryRateLimiter(id, policy)
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
