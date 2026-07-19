import { createRateLimiter, requireRateLimit } from "@vite-hub/rate-limit"
import { cloudflareRateLimitDriver } from "@vite-hub/rate-limit/drivers/cloudflare"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"

// @ts-expect-error the unreleased managed handle API was removed.
import { defineRateLimit } from "@vite-hub/rate-limit"
// @ts-expect-error the duration parser is internal policy machinery.
import { parseRateLimitWindow } from "@vite-hub/rate-limit"
// @ts-expect-error the managed handle type was removed.
import type { RateLimitHandle } from "@vite-hub/rate-limit"
// @ts-expect-error request events are passed directly to requireRateLimit().
import { runWithRateLimitRuntimeEvent } from "@vite-hub/rate-limit/runtime"

const local = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: "1m" })
const cloudflare = createRateLimiter({
  driver: cloudflareRateLimitDriver({
    binding: { limit: async () => ({ success: true }) },
  }),
  limit: 10,
  window: "1m",
})

export async function upload(event: Parameters<typeof requireRateLimit>[0]): Promise<void> {
  await requireRateLimit(event, "image-upload", {
    limit: 5,
    window: "1m",
  })
  await requireRateLimit(event, "user-upload", {
    key: "user",
    limit: 10,
    window: "1m",
  })
}

await local.consume({ key: "user" })
await cloudflare.consume({ key: "user" })
void cloudflare.capabilities.scope
void defineRateLimit
void parseRateLimitWindow
void (undefined as unknown as RateLimitHandle)
void runWithRateLimitRuntimeEvent
hubRateLimit({ provider: "cloudflare" })
