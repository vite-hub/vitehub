import { getCloudflareRateLimitBindingName } from "../integrations/cloudflare.ts"
import { normalizeRateLimitPolicy } from "../policy.ts"

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

// Cloudflare documents `period` as 10 or 60 seconds: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
function cloudflareSimpleLimit(declaration: RateLimitDeclaration): { limit: number, period: 10 | 60 } {
  const policy = normalizeRateLimitPolicy(declaration.policy)
  if (policy.enforcement === "strict") {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0015({ message: `Rate Limit "${declaration.name}" requires strict enforcement, but Cloudflare's native Rate Limiting binding is best-effort.` })
  }
  const period = policy.windowMs / 1_000
  if (period !== 10 && period !== 60) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0016({ message: `Rate Limit "${declaration.name}" uses ${policy.window}, but Cloudflare Rate Limiting supports only 10s and 1m windows.` })
  }
  return { limit: policy.limit, period }
}

/** Throws the build error for the first policy that a Cloudflare Rate Limiting binding cannot run. */
export function assertCloudflareRateLimitPolicies(declarations: RateLimitDeclaration[]): void {
  for (const declaration of declarations) cloudflareSimpleLimit(declaration)
}

export function createCloudflareRateLimitBindings(
  declarations: RateLimitDeclaration[],
  namespace: string,
): CloudflareRateLimitBindingConfig[] {
  return declarations.map(declaration => ({
    name: getCloudflareRateLimitBindingName(declaration.name),
    namespace_id: namespaceId(namespace, declaration.name),
    simple: cloudflareSimpleLimit(declaration),
  }))
}
