import { kv } from 'vite-hub/kv'
import { parseMarkdown } from '@nuxtjs/mdc/runtime'

export default eventHandler(async (event) => {
  await requireUserSession(event)
  const { slug } = event.context.params || {}
  if (!slug) {
    throw createError({ statusCode: 400, message: 'Missing slug' })
  }
  // Force being a string
  const { body } = await readBody(event)
  const parsed = await parseMarkdown(body)

  const [error] = await kv.set(slug, { body, parsed })
  if (error) throw error

  return { slug, body, parsed }
})
