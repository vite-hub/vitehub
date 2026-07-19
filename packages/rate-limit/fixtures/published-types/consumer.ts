import { createRateLimiter, defineRateLimit } from "@vite-hub/rate-limit"
import { cloudflareRateLimitDriver } from "@vite-hub/rate-limit/drivers/cloudflare"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"

const uploads = defineRateLimit("uploads", { limit: 10, window: "1m" })
const local = createRateLimiter({ driver: memoryRateLimitDriver(), limit: 10, window: "1m" })
const cloudflare = createRateLimiter({
  driver: cloudflareRateLimitDriver({
    binding: { limit: async () => ({ success: true }) },
    name: "uploads",
  }),
  limit: 10,
  window: "1m",
})

await uploads.consume()
await uploads.enforce("user")
await local.consume({ key: "user" })
await cloudflare.consume({ key: "user" })
void cloudflare.capabilities.scope
hubRateLimit({ provider: "cloudflare" })
