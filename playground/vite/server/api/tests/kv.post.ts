import { defineEventHandler } from "h3"
import { kv } from "@vitehub/kv"

export default defineEventHandler(async () => {
  const key = "smoke"
  await kv.set(key, { key, store: "kv" })
  return { ok: true, value: await kv.get(key) }
})
