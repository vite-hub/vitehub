import type { BlobMedia, BlobResult, BlobStorage } from "../types.ts"

/** Media API of a store that resolves on first use. Resolution failures return as `[error, undefined]`. */
export function createLazyBlobMedia(resolve: () => Promise<BlobResult<BlobStorage>>): BlobMedia {
  async function media(): Promise<BlobResult<BlobMedia>> {
    const [error, storage] = await resolve()
    return error ? [error, undefined] : [null, storage.media]
  }
  return {
    async createFolder(path) { const [error, target] = await media(); return error ? [error, undefined] : target.createFolder(path) },
    async get(pathname) { const [error, target] = await media(); return error ? [error, undefined] : target.get(pathname) },
    async handleUpload(event, options) { const [error, target] = await media(); return error ? [error, undefined] : target.handleUpload(event, options) },
    async list(options) { const [error, target] = await media(); return error ? [error, undefined] : target.list(options) },
    async move(from, to, options) { const [error, target] = await media(); return error ? [error, undefined] : target.move(from, to, options) },
    async moveFolder(from, to) { const [error, target] = await media(); return error ? [error, undefined] : target.moveFolder(from, to) },
    async put(pathname, body, options) { const [error, target] = await media(); return error ? [error, undefined] : target.put(pathname, body, options) },
    async remove(pathname) { const [error, target] = await media(); return error ? [error, undefined] : target.remove(pathname) },
    async removeFolder(path, options) { const [error, target] = await media(); return error ? [error, undefined] : target.removeFolder(path, options) },
    async replaceCrop(pathname, crop, body) { const [error, target] = await media(); return error ? [error, undefined] : target.replaceCrop(pathname, crop, body) },
    async update(pathname, patch) { const [error, target] = await media(); return error ? [error, undefined] : target.update(pathname, patch) },
    async variants(pathname) { const [error, target] = await media(); return error ? [error, undefined] : target.variants(pathname) },
  }
}
