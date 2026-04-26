import { defineEventHandler, getQuery } from "h3"
import { kv } from "@vitehub/kv"

export default defineEventHandler(async (event) => {
  const marker = getQuery(event).marker
  const key = typeof marker === "string" && marker.length > 0
    ? `workflow-e2e:${marker}`
    : ""

  return {
    ok: true,
    seen: key ? await kv.has(key) : false,
  }
})
