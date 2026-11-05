import { getStandardContext } from "@vite-hub/runtime/h3"
import { createError } from "h3"

import { cloudflareRateLimitDriver } from "./drivers/cloudflare.ts"
import { getCloudflareRateLimitBindingName } from "./integrations/cloudflare.ts"
import { createRateLimiter } from "./limiter.ts"
import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"
import {
  getMemoryRateLimiter,
  getRateLimitRuntimeConfig,
} from "./runtime/state.ts"

import type { ViteHubStandardProps } from "@vite-hub/runtime"
import type { CloudflareRateLimitBinding } from "./drivers/cloudflare.ts"
import type { RateLimitDecision, RateLimiter, RateLimitPolicy, RateLimitRequestEvent, RequireRateLimitOptions } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

const guardOptionKeys = new Set([...rateLimitPolicyKeys, "key"])

function isCloudflareBinding(value: unknown): value is CloudflareRateLimitBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as CloudflareRateLimitBinding).limit === "function"
}

function getRequestKey(standard: ViteHubStandardProps, provider: "cloudflare" | "memory"): string | undefined {
  const clientAddress = standard.runtime?.clientAddress
  return provider === "cloudflare"
    ? standard.req.headers.get("cf-connecting-ip") || clientAddress
    : clientAddress
}

function getCloudflareRateLimiter(standard: ViteHubStandardProps, name: string, policy: RateLimitPolicy): RateLimiter {
  const bindingName = getCloudflareRateLimitBindingName(name)
  const env = standard.runtime?.cloudflare?.env
  const binding = env && Object.hasOwn(env, bindingName) ? env[bindingName] : undefined
  if (!isCloudflareBinding(binding)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0009({ message: `[vitehub] Cloudflare Rate Limit binding "${bindingName}" was not found on the request event.` })
  }
  return createRateLimiter({
    ...policy,
    driver: cloudflareRateLimitDriver({ binding }),
    name,
  })
}

async function consumeRateLimit(
  event: RateLimitRequestEvent,
  name: string,
  options: RequireRateLimitOptions,
  guard: "checkRateLimit" | "requireRateLimit",
): Promise<RateLimitDecision> {
  const id = typeof name === "string" ? name.trim() : ""
  if (!id) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0010({ message: `\`${guard}()\` requires a non-empty stable ID.` })
  }
  const unknownKey = options && typeof options === "object" && !Array.isArray(options)
    ? Object.keys(options).find(key => !guardOptionKeys.has(key))
    : undefined
  if (unknownKey) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0011({ message: `\`${guard}()\` does not support the "${unknownKey}" option.` })
  }
  if (options?.key !== undefined && (typeof options.key !== "string" || options.key.length === 0)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0012({ message: `\`${guard}()\` key must be a non-empty string.` })
  }

  const policy = declaredRateLimitPolicy(normalizeRateLimitPolicy(options))
  const { provider } = getRateLimitRuntimeConfig()
  const standard = getStandardContext(event)
  const key = options.key ?? getRequestKey(standard, provider)
  if (!key) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0013({ message: `[vitehub] \`${guard}()\` could not determine a request key. Pass key when limiting by user or tenant or when the request has no client address.` })
  }
  const limiter = provider === "cloudflare"
    ? getCloudflareRateLimiter(standard, id, policy)
    : getMemoryRateLimiter(id, policy)
  return await limiter.consume({ key })
}

/**
 * Consumes one request from a managed Rate Limit and returns the decision instead of throwing. Use it when a limited
 * request still gets an answer, such as a cheaper fallback. `reason` is `limited` or `unavailable` when not allowed.
 * Shares counters, discovery, and Provider Output with `requireRateLimit()`. Invalid options still throw.
 */
export async function checkRateLimit(event: RateLimitRequestEvent, name: string, options: RequireRateLimitOptions): Promise<RateLimitDecision> {
  return await consumeRateLimit(event, name, options, "checkRateLimit")
}

export async function requireRateLimit(event: RateLimitRequestEvent, name: string, options: RequireRateLimitOptions): Promise<void> {
  const decision = await consumeRateLimit(event, name, options, "requireRateLimit")
  if (decision.allowed) return

  if (decision.reason === "unavailable") {
    throw rateLimitHTTPError(event, {
      cause: decision.cause,
      message: "Rate limiting is unavailable.",
      status: 503,
      statusText: "Service Unavailable",
    })
  }

  throw rateLimitHTTPError(event, {
    headers: decision.retryAfter === undefined
      ? undefined
      : { "Retry-After": String(decision.retryAfter) },
    message: "Rate limit exceeded.",
    status: 429,
    statusText: "Too Many Requests",
  })
}

/**
 * Nuxt 4 bundles every `h3` import as its own h3 1, which has `createError()` but no `HTTPError`. h3 2's
 * `createError()` returns an `HTTPError` with headers. An h3 1 error carries no headers, so they go on the response.
 */
function rateLimitHTTPError(event: RateLimitRequestEvent, details: { cause?: unknown, headers?: Record<string, string>, message: string, status: number, statusText: string }): Error {
  const error = createError(details)
  if (details.headers && !(Reflect.get(error, "headers") instanceof Headers)) {
    const headers = getStandardContext(event).res.headers
    for (const [name, value] of Object.entries(details.headers)) headers?.set(name, value)
  }
  return error
}
