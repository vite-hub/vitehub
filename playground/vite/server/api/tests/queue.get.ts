import { defineEventHandler, getQuery } from "h3"
import { kv } from "@vite-hub/kv"

export default defineEventHandler(async (event) => {
  const marker = getQuery(event).marker
  const key = typeof marker === "string" && marker.length > 0
    ? `queue-e2e:${marker}`
    : ""

  const [error, seen] = key ? await kv.has(key) : [null, false] as const
  if (error) throw error
  return {
    ok: true,
    seen,
  }
})
