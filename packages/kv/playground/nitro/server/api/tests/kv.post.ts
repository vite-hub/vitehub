import { defineEventHandler, readBody } from "nitro/h3"
import { kv } from "@vitehub/kv"

export default defineEventHandler(async (event) => {
  const { key = "smoke" } = await readBody<{ key?: string }>(event)
  const storeKey = `tests:${key}`
  await kv.set(storeKey, { key, store: "kv" })
  return { ok: true, value: await kv.get(storeKey) }
})
