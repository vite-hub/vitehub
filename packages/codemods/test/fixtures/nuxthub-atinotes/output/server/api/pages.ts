import { kv } from 'vite-hub/kv'

export default eventHandler(async () => {
  const [error, result] = await kv.keys()
  if (error) throw error
  return result
})
