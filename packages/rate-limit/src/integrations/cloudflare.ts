import { encodeNameHex } from "@vite-hub/internal/integrations/hex"

const bindingPrefix = "RATE_LIMIT"

export function getCloudflareRateLimitBindingName(name: string): string {
  const encoded = encodeNameHex(name).toUpperCase()
  return encoded ? `${bindingPrefix}_${encoded}` : bindingPrefix
}
