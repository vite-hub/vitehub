import { defineHandler, readBody } from "h3"
import { kv } from "vite-hub/kv"

export default defineHandler(async (event) => {
  const { key, value } = await readBody<{ key: string, value: string }>(event) ?? { key: "", value: "" }
  const [error] = await kv.set(key, value)
  if (error) throw error
  return { ok: true }
})
