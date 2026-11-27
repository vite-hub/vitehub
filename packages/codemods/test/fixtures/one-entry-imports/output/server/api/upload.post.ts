import { blob, ensureBlob, detectContentType } from 'vite-hub/blob'
import { image } from '@vite-hub/blob'

export const avatar = image({ maxSize: '1MB' })

export default async (file: File) => {
  ensureBlob(file, { maxSize: '1MB' })
  const type = detectContentType(new Uint8Array(await file.arrayBuffer()))
  return blob.put(file.name, file, { contentType: type })
}
