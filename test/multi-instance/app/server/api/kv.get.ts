import { defineHandler, getQuery } from "h3"
import { kv } from "vite-hub/kv"

export default defineHandler(async (event) => {
  const [error, value] = await kv.get(String(getQuery(event).key))
  if (error) throw error
  return { value: value ?? null }
})
