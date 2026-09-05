import type { RateLimitDriver } from "../types.ts"
import { rateLimitErrorDiagnostics } from "../error-diagnostics.ts"

export { getCloudflareRateLimitBindingName } from "../integrations/cloudflare.ts"

export interface CloudflareRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

export interface CloudflareRateLimitDriverOptions {
  binding: CloudflareRateLimitBinding
}

function isBinding(value: unknown): value is CloudflareRateLimitBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as CloudflareRateLimitBinding).limit === "function"
}

export function cloudflareRateLimitDriver(options: CloudflareRateLimitDriverOptions): RateLimitDriver {
  if (!isBinding(options?.binding)) {
    throw rateLimitErrorDiagnostics.RATE_LIMIT_R0004({ message: "[vitehub] cloudflareRateLimitDriver() requires a Cloudflare Rate Limit binding." })
  }
  return {
    capabilities: {
      enforcement: "best-effort",
      rejectedAttempts: "unknown",
      scope: "location",
      windows: [10_000, 60_000],
    },
    async consume(input) {
      let result
      try {
        result = await options.binding.limit({ key: input.key })
      }
      catch (cause) {
        return [rateLimitErrorDiagnostics.RATE_LIMIT_R0005({ message: "[vitehub] Cloudflare Rate Limit binding failed.", ...{ cause } }), undefined]
      }
      if (!result || typeof result.success !== "boolean") {
        throw rateLimitErrorDiagnostics.RATE_LIMIT_R0006({ message: "[vitehub] Cloudflare Rate Limit binding returned an invalid result." })
      }
      return [null, { allowed: result.success }]
    },
    name: "cloudflare",
  }
}
