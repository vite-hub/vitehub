import { blob } from 'vite-hub/blob'

export default eventHandler(async (event) => {
  const { pathname } = event.context.params || {}

  const [error, result] = await blob.del(pathname)
  if (error) throw error
  return result
})
