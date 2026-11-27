import { getCloudflareRateLimitBindingName, isCloudflareRateLimitWindow } from "../integrations/cloudflare.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"
import { resolveKVRateLimitDriver } from "./kv-provider.ts"

import type { RateLimitDeclaration } from "../types.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"

interface CloudflareRateLimitBindingConfig {
  [key: string]: unknown
  name: string
  namespace_id: string
  simple: {
    limit: number
    period: 10 | 60
  }
}

function namespaceId(namespace: string, rateLimitId: string): string {
  let hash = 2_166_136_261
  for (const character of `${namespace}:${rateLimitId}`) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16_777_619)
  }
  return String((hash >>> 0) || 1)
}

/** True when the Cloudflare Rate Limiting binding counts this Rate Limit. Other windows count in KV. */
export function usesCloudflareBinding(declaration: RateLimitDeclaration): boolean {
  return isCloudflareRateLimitWindow(normalizeRateLimitPolicy(declaration.policy).windowMs)
}

function cloudflareSimpleLimit(declaration: RateLimitDeclaration): { limit: number, period: 10 | 60 } {
  const policy = normalizeRateLimitPolicy(declaration.policy)
  if (policy.enforcement === "strict") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0015({ message: `Rate Limit "${declaration.name}" requires strict enforcement, but Cloudflare's native Rate Limiting binding is best-effort.` })
  }
  // SAFETY: usesCloudflareBinding() selected a 10 or 60 second window.
  return { limit: policy.limit, period: policy.windowMs / 1_000 as 10 | 60 }
}

/**
 * Throws the build error for the first policy that Cloudflare cannot run: strict enforcement on the binding, or a
 * window other than 10 or 60 seconds when the default KV store, which uses `kvDriver`, cannot share its counts.
 */
export function assertCloudflareRateLimitPolicies(declarations: RateLimitDeclaration[], kvDriver: string | undefined): void {
  for (const declaration of declarations) {
    if (usesCloudflareBinding(declaration)) {
      cloudflareSimpleLimit(declaration)
      continue
    }
    if (resolveKVRateLimitDriver(kvDriver) === "kv") continue
    const store = kvDriver ? `the default KV store uses ${kvDriver}, which has no shared atomic increment` : "the app has no KV store"
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0016({ message: `Rate Limit "${declaration.name}" uses ${declaration.policy.window}. Cloudflare Rate Limiting supports only 10s and 1m windows, so ViteHub counts other windows in KV, but ${store}.` })
  }
}

export function createCloudflareRateLimitBindings(
  declarations: RateLimitDeclaration[],
  namespace: string,
): CloudflareRateLimitBindingConfig[] {
  return declarations.filter(usesCloudflareBinding).map(declaration => ({
    name: getCloudflareRateLimitBindingName(declaration.name),
    namespace_id: namespaceId(namespace, declaration.name),
    simple: cloudflareSimpleLimit(declaration),
  }))
}
