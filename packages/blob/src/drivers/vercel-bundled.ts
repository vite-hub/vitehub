import { del, get, head, list, put } from "@vercel/blob"

import type { BlobDriverAdapter, BlobObject, BlobPutBody, BlobPutOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"

function toBlobObject(blob: {
  contentType?: string
  etag?: string
  pathname: string
  size: number
  uploadedAt: Date
  url?: string
}): BlobObject {
  return {
    contentType: blob.contentType,
    customMetadata: {},
    httpEtag: blob.etag,
    httpMetadata: blob.contentType ? { contentType: blob.contentType } : {},
    pathname: blob.pathname,
    size: blob.size,
    uploadedAt: blob.uploadedAt,
    url: blob.url,
  }
}

export function createDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  const auth = { token: options.token }

  return {
    name: options.driver,
    options,
    async delete(pathnames) {
      await del(pathnames, auth)
    },
    async get(pathname) {
      const result = await get(pathname, { ...auth, access: "private" })
      if (!result) return null
      return await new Response(result.stream, { headers: { "content-type": result.blob.contentType } }).blob()
    },
    async getArrayBuffer(pathname) {
      const result = await get(pathname, { ...auth, access: "private" })
      return result ? await new Response(result.stream).arrayBuffer() : null
    },
    async head(pathname) {
      try {
        return toBlobObject(await head(pathname, auth))
      }
      catch (error) {
        if (error instanceof Error && /not found/i.test(`${error.name} ${error.message}`)) return null
        throw error
      }
    },
    async list(listOptions = {}) {
      const result = await list({
        ...auth,
        cursor: listOptions.cursor,
        limit: listOptions.limit,
        prefix: listOptions.prefix,
      })
      return {
        blobs: result.blobs.map(toBlobObject),
        cursor: result.cursor,
        hasMore: result.hasMore,
      }
    },
    async put(pathname, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const result = await put(pathname, body, {
        ...auth,
        access: putOptions.access || options.access,
        addRandomSuffix: false,
        allowOverwrite: options.allowOverwrite ?? true,
        contentType: putOptions.contentType,
      })
      return {
        ...toBlobObject(result),
        customMetadata: putOptions.customMetadata || {},
      }
    },
  }
}
