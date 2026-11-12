import { kv } from 'vite-hub/kv'

interface Note {
  body: string
  parsed?: object
}

export default eventHandler(async (event) => {
  const { slug } = event.context.params || {}
  if (!slug) {
    throw createError({ statusCode: 400, message: 'Missing slug' })
  }

  const [error, result] = await kv.get<Note>(slug)
  if (error) throw error
  let note = result

  if (!note) {
    note = { body: '# Hello' }
    note.parsed = await parseMarkdown(note.body)
  }

  return { slug, ...note }
})
