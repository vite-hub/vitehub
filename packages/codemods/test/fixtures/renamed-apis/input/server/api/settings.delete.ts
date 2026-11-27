import { kv } from "vite-hub/kv"

export default defineEventHandler(async () => {
  const [error] = await kv.del("settings")
  if (error) throw error
  const [cacheError] = await kv.store("cache").del("settings")
  if (cacheError) throw cacheError
  return { deleted: true }
})
