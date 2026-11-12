import { createError, defineEventHandler, getRouterParam } from 'nuxt/server'
import { blob } from 'vite-hub/blob'

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const { username } = user

  const pathname = getRouterParam(event, 'pathname', { decode: true })

  if (!pathname?.startsWith(`${username}/`)) {
    throw createError({
      status: 403,
      statusText: 'You do not have permission to delete this file'
    })
  }

  const [error] = await blob.del(pathname)
  if (error) throw error

  return new Response(null, { status: 204 })
})
