import { defineHandler } from "h3"
import { checkRateLimit, requireRateLimit } from "vite-hub/rate-limit"
import { getRuntimeContext, installStandardContext, type H3RuntimeContext } from "vite-hub/runtime/h3"

export default defineHandler(async (event) => {
  await requireRateLimit(event, "search-burst", { limit: 100, window: "1m" })
  const decision = await checkRateLimit(event, "search", { limit: 30, window: "1m" })
  if (!decision.allowed) return { results: [], retryAfter: decision.retryAfter }
  const runtime: H3RuntimeContext = getRuntimeContext(event)
  installStandardContext(event)
  return { results: [], runtime: runtime.runtime }
})
