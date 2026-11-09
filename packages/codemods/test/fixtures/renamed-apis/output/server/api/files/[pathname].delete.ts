import { blob as files } from "vite-hub/blob"

export default defineEventHandler(async (event) => {
  const pathname = getRouterParam(event, "pathname")
  if (!pathname) throw createError({ statusCode: 400 })
  const remove = files.delete
  const [error] = await remove(pathname)
  if (error) throw error
  const cache = new Map<string, string>()
  cache.delete(pathname)
  return { deleted: true }
})
