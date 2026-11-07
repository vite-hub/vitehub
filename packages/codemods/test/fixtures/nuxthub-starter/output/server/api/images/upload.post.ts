import { blob } from 'vite-hub/blob'

export default eventHandler(async (event) => {
  const [error, result] = await blob.handleUpload(event, {
    multiple: false,
    ensure: {
      maxSize: '8MB',
      types: ['image/png', 'image/jpeg'],
    },
  })
  if (error) throw error
  return result
})
