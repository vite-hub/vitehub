import { encodeNameHex } from "@vite-hub/internal/integrations/hex"

const bindingPrefix = "RATE_LIMIT"

export function getCloudflareRateLimitBindingName(name: string): string {
  const encoded = encodeNameHex(name).toUpperCase()
  return encoded ? `${bindingPrefix}_${encoded}` : bindingPrefix
}

/**
 * Cloudflare documents `period` as 10 or 60 seconds: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 * A Rate Limit with another window counts in KV on Cloudflare.
 */
export function isCloudflareRateLimitWindow(windowMs: number): boolean {
  return windowMs === 10_000 || windowMs === 60_000
}
