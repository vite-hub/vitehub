import { toResultError } from "@vite-hub/runtime"
import { getActiveCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"
import { getStandardContext } from "@vite-hub/runtime/internal/h3"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"
import { createError } from "h3"

import { cloudflareRateLimitDriver } from "./drivers/cloudflare.ts"
import { getCloudflareRateLimitBindingName } from "./integrations/cloudflare.ts"
import { createRateLimiter } from "./limiter.ts"
import { declaredRateLimitPolicy, normalizeRateLimitPolicy, rateLimitPolicyKeys } from "./policy.ts"
import { getRuntimeRateLimiter, resolveRateLimitProvider } from "./runtime/state.ts"

import type { Result, ResultError, ViteHubContext } from "@vite-hub/runtime"
import type { CloudflareRateLimitBinding } from "./drivers/cloudflare.ts"
import type { CheckRateLimitErrorCode, RateLimitDecision, RateLimiter, RateLimitPolicy, RateLimitRequest, RateLimitRequestEvent, RequireRateLimitOptions } from "./types.ts"
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
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object"
}

function isWebRequest(value: unknown): value is Request {
  if (value instanceof Request) return true
  if (!isObject(value)) return false
  const headers: unknown = Reflect.get(value, "headers")
  return typeof Reflect.get(value, "url") === "string"
    && typeof Reflect.get(value, "method") === "string"
    && isObject(headers)
    && typeof Reflect.get(headers, "get") === "function"
}

/** Structural Requests may carry unrelated event-named properties, so identify the event's shape. */
function isRequestEvent(input: RateLimitRequestEvent): input is ViteHubContext {
  if ("~standard" in input) {
    const standard: unknown = input["~standard"]
    return isObject(standard)
      && typeof Reflect.get(standard, "vendor") === "string"
      && isWebRequest(Reflect.get(standard, "req"))
      && isObject(Reflect.get(standard, "res"))
  }
  // Match the H3 shape that getStandardContext() can adapt when Nitro has not installed it yet.
  return Object.hasOwn(input, "req") && isWebRequest(Reflect.get(input, "req")) && isObject(Reflect.get(input, "res"))
}

function getRequestScope(input: RateLimitRequestEvent): RateLimitRequestScope {
  // A Request has no client address. On Cloudflare, the bindings are those of the request that runs.
  if (!isRequestEvent(input)) return { cloudflareEnv: getActiveCloudflareEnv(), headers: input.headers }
  const standard = getStandardContext(input)
  return {
    clientAddress: standard.runtime?.clientAddress,
    cloudflareEnv: standard.runtime?.cloudflare?.env,
    headers: standard.req.headers,
  }
}

function getRequestKey(scope: RateLimitRequestScope, provider: "cloudflare" | "kv" | "memory"): string | undefined {
  return provider === "cloudflare"
    ? scope.headers.get("cf-connecting-ip") || scope.clientAddress
    : scope.clientAddress
}

/** A failure of one check, such as a request without a key. Option errors throw instead. */
function checkError<TCode extends CheckRateLimitErrorCode>(code: TCode, message: string): ResultError<TCode> {
  const diagnostic = code === "RATE_LIMIT_R0009"
    ? rateLimitErrorDiagnostics.RATE_LIMIT_R0009({ message })
    : rateLimitErrorDiagnostics.RATE_LIMIT_R0013({ message })
  // SAFETY: Nostics sets `code` to the catalog key, which is `code`.
  return toResultError(diagnostic as typeof diagnostic & { readonly code: TCode })
}

function getCloudflareRateLimiter(scope: RateLimitRequestScope, name: string, policy: RateLimitPolicy): Result<RateLimiter, "RATE_LIMIT_R0009"> {
  const bindingName = getCloudflareRateLimitBindingName(name)
  const env = scope.cloudflareEnv
  const binding = env && Object.hasOwn(env, bindingName) ? env[bindingName] : undefined
  if (!isCloudflareBinding(binding)) {
    return [checkError("RATE_LIMIT_R0009", `[vitehub] Cloudflare Rate Limit binding "${bindingName}" was not found on the request event.`), undefined]
  }
  return [undefined, createRateLimiter({
    ...policy,
    driver: cloudflareRateLimitDriver({ binding }),
    name,
  })]
}

async function consumeRateLimit(
  event: RateLimitRequestEvent,
  name: string,
  options: RequireRateLimitOptions,
  guard: "checkRateLimit" | "requireRateLimit",
): Promise<Result<RateLimitDecision, CheckRateLimitErrorCode>> {
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
  const provider = await resolveRateLimitProvider()
  const scope = getRequestScope(event)
  // A test request has no client address, so in app tests all requests without a key count as one client.
  const key = options.key ?? getRequestKey(scope, provider) ?? (getViteHubTestMode() ? "test-client" : undefined)
  if (!key) {
    return [checkError("RATE_LIMIT_R0013", `[vitehub] \`${guard}()\` could not determine a request key. Pass key when limiting by user or tenant or when the request has no client address.`), undefined]
  }
  const [error, limiter] = provider === "cloudflare"
    ? getCloudflareRateLimiter(scope, id, policy)
    : [undefined, getRuntimeRateLimiter(provider, id, policy)] as const
  if (error) return [error, undefined]
  return [undefined, await limiter.consume({ key })]
}

/**
 * Consumes one request from a managed Rate Limit and returns `[error, decision]`. Use it when a limited request still
 * gets an answer, such as a cheaper fallback. `decision.reason` is `limited` or `unavailable` when not allowed.
 * `error` is set when the check cannot run: `RATE_LIMIT_R0013` for a request without a key, `RATE_LIMIT_R0009` for a
 * missing Cloudflare binding. Shares counters, discovery, and Provider Output with `requireRateLimit()`. Invalid
 * options throw.
 */
export async function checkRateLimit(event: RateLimitRequestEvent, name: string, options: RequireRateLimitOptions): Promise<Result<RateLimitDecision, CheckRateLimitErrorCode>> {
  return await consumeRateLimit(event, name, options, "checkRateLimit")
}

/**
 * Consumes one request from a managed Rate Limit inside a handler. Returns when the request is allowed. Otherwise
 * it throws an HTTP error: `429` with `Retry-After` when the limit is reached, `503` when the limiter is unavailable.
 * It also throws the errors that `checkRateLimit()` returns.
 */
export async function requireRateLimit(event: RateLimitRequestEvent, name: string, options: RequireRateLimitOptions): Promise<void> {
  const [error, decision] = await consumeRateLimit(event, name, options, "requireRateLimit")
  if (error) throw error
  if (decision.allowed) return

  if (decision.reason === "unavailable") {
    throw createError({
      cause: decision.cause,
      message: "Rate limiting is unavailable.",
      status: 503,
      statusText: "Service Unavailable",
    })
  }

  throw createError({
    headers: decision.retryAfter === undefined
      ? undefined
      : { "Retry-After": String(decision.retryAfter) },
    message: "Rate limit exceeded.",
    status: 429,
    statusText: "Too Many Requests",
  })
}
