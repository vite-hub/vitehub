import { defineEventHandler } from "h3"
import { requireRateLimit } from "vite-hub/rate-limit"

// Reload the preview: the fourth request in a minute gets a 429 response.
export default defineEventHandler(async (event) => {
  await requireRateLimit(event, "upload", { limit: 3, window: "1m" })
  return { ok: true }
})
