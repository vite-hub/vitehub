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

export function createCloudflareRateLimitBindings(
  declarations: RateLimitDeclaration[],
  namespace: string,
): CloudflareRateLimitBindingConfig[] {
  return declarations.map((declaration) => {
    const policy = normalizeRateLimitPolicy(declaration.policy)
    if (policy.enforcement === "strict") {
      throw rateLimitErrorDiagnostics.RATE_LIMIT_R0015({ message: `Rate Limit "${declaration.name}" requires strict enforcement, but Cloudflare's native Rate Limiting binding is best-effort.` })
    }
    const period = policy.windowMs / 1_000
    if (period !== 10 && period !== 60) {
      throw rateLimitErrorDiagnostics.RATE_LIMIT_R0016({ message: `Rate Limit "${declaration.name}" uses ${policy.window}, but Cloudflare Rate Limiting supports only 10s and 1m windows.` })
    }
    return {
      name: getCloudflareRateLimitBindingName(declaration.name),
      namespace_id: namespaceId(namespace, declaration.name),
      simple: { limit: policy.limit, period },
    }
  })
}
