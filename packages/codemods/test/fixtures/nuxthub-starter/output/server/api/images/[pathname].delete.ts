import { blob } from 'vite-hub/blob'

export default eventHandler(async (event) => {
  const { pathname } = event.context.params || {}

  return blob.del(pathname)
})
