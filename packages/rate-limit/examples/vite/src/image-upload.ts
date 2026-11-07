import { requireRateLimit } from "@vite-hub/rate-limit"

import type { RateLimitRequestEvent } from "@vite-hub/rate-limit"

export async function handleImageUpload(event: RateLimitRequestEvent): Promise<Response> {
  await requireRateLimit(event, "image-upload", {
    limit: 5,
    window: "1m",
  })
  return new Response("Upload accepted", { status: 202 })
}
