import { kv } from 'vite-hub/kv'

export default eventHandler(async (event) => {
  const body = await readBody(event)

  // Used in server/middleware/redirects.ts
  const [error] = await kv.set('redirects', body)
  if (error) throw error

  return body
})
