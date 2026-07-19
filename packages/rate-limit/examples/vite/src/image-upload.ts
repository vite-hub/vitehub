import { requireRateLimit } from "@vite-hub/rate-limit"

import type { HTTPEvent } from "h3"

export async function handleImageUpload(event: HTTPEvent): Promise<Response> {
  await requireRateLimit(event, "image-upload", {
    limit: 5,
    window: "1m",
  })
  return new Response("Upload accepted", { status: 202 })
}
