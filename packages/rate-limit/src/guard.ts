import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
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

import type { ViteHubContext, ViteHubStandardProps } from "@vite-hub/runtime"
import type { CloudflareRateLimitBinding } from "./drivers/cloudflare.ts"
import type { RateLimitDecision, RateLimiter, RateLimitPolicy, RateLimitRequest, RateLimitRequestEvent, RequireRateLimitOptions } from "./types.ts"
import { rateLimitErrorDiagnostics } from "./error-diagnostics.ts"

const guardOptionKeys = new Set([...rateLimitPolicyKeys, "key"])

function isCloudflareBinding(value: unknown): value is CloudflareRateLimitBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as CloudflareRateLimitBinding).limit === "function"
}

/** What a guard reads from the request that it limits. */
interface RateLimitRequestScope {
  clientAddress?: string
  cloudflareEnv?: Record<string, unknown>
  headers: RateLimitRequest["headers"]
  /** Present for a request event. A `Request` has no response to carry headers. */
  standard?: ViteHubStandardProps
}

/** A request event carries `~standard`, an H3 2 `req`, or an H3 1 `node`. A Web `Request` has none of them. */
function isRequestEvent(input: RateLimitRequestEvent): input is ViteHubContext {
  return "~standard" in input || "req" in input || "node" in input
}

function getRequestScope(input: RateLimitRequestEvent): RateLimitRequestScope {
  // A Request has no client address. On Cloudflare, the bindings are those of the request that runs.
  if (!isRequestEvent(input)) return { cloudflareEnv: getActiveCloudflareEnv(), headers: input.headers }
  const standard = getStandardContext(input)
  return {
    clientAddress: standard.runtime?.clientAddress,
    cloudflareEnv: standard.runtime?.cloudflare?.env,
    headers: standard.req.headers,
    standard,
  }
}

function getRequestKey(scope: RateLimitRequestScope, provider: "cloudflare" | "memory"): string | undefined {
  return provider === "cloudflare"
    ? scope.headers.get("cf-connecting-ip") || scope.clientAddress
    : scope.clientAddress
}

function getCloudflareRateLimiter(scope: RateLimitRequestScope, name: string, policy: RateLimitPolicy): RateLimiter {
  const bindingName = getCloudflareRateLimitBindingName(name)
  const env = scope.cloudflareEnv
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
  const scope = getRequestScope(event)
  const key = options.key ?? getRequestKey(scope, provider)
  if (!key) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0013({ message: `[vitehub] \`${guard}()\` could not determine a request key. Pass key when limiting by user or tenant or when the request has no client address.` })
  }
  const limiter = provider === "cloudflare"
    ? getCloudflareRateLimiter(scope, id, policy)
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
 * `createError()` returns an `HTTPError` with headers. An h3 1 error carries no headers, so they go on the response
 * of a request event.
 */
function rateLimitHTTPError(event: RateLimitRequestEvent, details: { cause?: unknown, headers?: Record<string, string>, message: string, status: number, statusText: string }): Error {
  const error = createError(details)
  if (details.headers && !(Reflect.get(error, "headers") instanceof Headers) && isRequestEvent(event)) {
    const headers = getStandardContext(event).res.headers
    for (const [name, value] of Object.entries(details.headers)) headers?.set(name, value)
  }
  return error
}
