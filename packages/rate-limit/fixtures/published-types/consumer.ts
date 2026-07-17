import { consumeRateLimit, createRateLimiter, defineRateLimit } from "@vite-hub/rate-limit"
import { cloudflareRateLimitDriver } from "@vite-hub/rate-limit/drivers/cloudflare"
import { memoryRateLimitDriver } from "@vite-hub/rate-limit/drivers/memory"
import { setRateLimitRuntimeRegistry } from "@vite-hub/rate-limit/runtime"
import { hubRateLimit } from "@vite-hub/rate-limit/vite"
import registry from "#vitehub/rate-limit/registry"

const definition = defineRateLimit({ limit: 10, window: "1m" })
const local = createRateLimiter({ ...definition, driver: memoryRateLimitDriver() })
const cloudflare = createRateLimiter({
  ...definition,
  driver: cloudflareRateLimitDriver({
    binding: { limit: async () => ({ success: true }) },
    name: "uploads",
  }),
})

setRateLimitRuntimeRegistry({ uploads: () => ({ default: definition }) })
await consumeRateLimit("uploads", { key: "user" })
await local.consume({ key: "user" })
await cloudflare.consume({ key: "user" })
void cloudflare.capabilities.scope
hubRateLimit({ namespace: "published-types", provider: "cloudflare" })
void registry.uploads
