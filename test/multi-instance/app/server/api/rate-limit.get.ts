import { defineHandler, getQuery } from "h3"
import { checkRateLimit } from "vite-hub/rate-limit"

export default defineHandler(async (event) => {
  const key = String(getQuery(event).key)
  const [error, decision] = await checkRateLimit(event, "multi-instance", { key, limit: 10, window: "1m" })
  if (error) throw error
  return { allowed: decision.allowed }
})
