import { getCloudflareEnv } from "@vite-hub/internal/runtime/cloudflare-env"

import { getCloudflareRateLimitBindingName } from "../integrations/cloudflare.ts"

import type { RateLimitDriver } from "../types.ts"

export { getCloudflareRateLimitBindingName } from "../integrations/cloudflare.ts"

export interface CloudflareRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>
}

export interface CloudflareRateLimitDriverOptions {
  binding?: CloudflareRateLimitBinding | string
  name?: string
}

function isBinding(value: unknown): value is CloudflareRateLimitBinding {
  return Boolean(value) && typeof value === "object" && typeof (value as CloudflareRateLimitBinding).limit === "function"
}

export function cloudflareRateLimitDriver(options: CloudflareRateLimitDriverOptions = {}): RateLimitDriver {
  return {
    capabilities: {
      enforcement: "best-effort",
      metadata: {
        remaining: { availability: "never" },
        resetAt: { availability: "never" },
        retryAfter: { availability: "never" },
        used: { availability: "never" },
      },
      rejectedAttempts: "unknown",
      scope: "location",
      windows: [10_000, 60_000],
    },
    async consume(input) {
      const configuredBinding = options.binding
      const bindingName = typeof configuredBinding === "string"
        ? configuredBinding
        : getCloudflareRateLimitBindingName(options.name ?? input.name ?? "default")
      const binding = isBinding(configuredBinding)
        ? configuredBinding
        : getCloudflareEnv(undefined)?.[bindingName]
      if (!isBinding(binding)) {
        throw new Error(`[vitehub] Cloudflare Rate Limit binding "${bindingName}" was not found.`)
      }
      const result = await binding.limit({ key: input.key })
      if (!result || typeof result.success !== "boolean") {
        throw new TypeError(`[vitehub] Cloudflare Rate Limit binding "${bindingName}" returned an invalid result.`)
      }
      return { allowed: result.success }
    },
    name: "cloudflare",
  }
}
