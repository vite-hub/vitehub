import { defineEventHandler } from "h3"
import { kv } from "@vite-hub/kv"

export default defineEventHandler(async () => {
  const key = "smoke"
  const [writeError] = await kv.set(key, { key, store: "kv" })
  if (writeError) throw writeError
  const [readError, value] = await kv.get(key)
  if (readError) throw readError
  return { ok: true, value }
})
