import { defineEventHandler, readBody } from "h3"
import { kv } from "@vitehub/kv"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ key?: string }>(event).catch(() => ({}))
  const key = body.key || "smoke"

  await kv.set(key, {
    key,
    store: "kv",
  })

  return {
    ok: true,
    value: await kv.get(key),
  }
})
