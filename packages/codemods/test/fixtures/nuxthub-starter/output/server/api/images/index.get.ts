import { blob } from 'vite-hub/blob'

export default eventHandler(async () => {
  const [error, result] = await blob.list()
  if (error) throw error
  const { blobs } = result

  return blobs
})
