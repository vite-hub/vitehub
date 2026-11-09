import { kv } from "vite-hub/kv"

export default defineEventHandler(async () => {
  const [error] = await kv.delete("settings")
  if (error) throw error
  const [cacheError] = await kv.store("cache").delete("settings")
  if (cacheError) throw cacheError
  return { deleted: true }
})
