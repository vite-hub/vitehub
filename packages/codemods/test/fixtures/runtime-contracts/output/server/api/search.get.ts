import { defineHandler } from "h3"
import { checkRateLimit, requireRateLimit } from "vite-hub/rate-limit"
import { installStandardContext } from "vite-hub/runtime/h3"
import { getRuntimeContext, type RequestRuntimeContext as H3RuntimeContext } from "vite-hub/runtime"

export default defineHandler(async (event) => {
  await requireRateLimit(event, "search-burst", { limit: 100, window: "1m" })
  const [checkRateLimitError, decision] = await checkRateLimit(event, "search", { limit: 30, window: "1m" })
  if (checkRateLimitError) throw checkRateLimitError
  if (!decision.allowed) return { results: [], retryAfter: decision.retryAfter }
  const runtime: H3RuntimeContext = getRuntimeContext(event)
  installStandardContext(event)
  return { results: [], runtime: runtime.runtime }
})
