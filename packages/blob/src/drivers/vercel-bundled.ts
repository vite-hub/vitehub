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

export function createBundledVercelBlobDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
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
      const headers = result.blob.contentType ? { "content-type": result.blob.contentType } : undefined
      return await new Response(result.stream, { headers }).blob()
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
      const result = await put(pathname, body as Parameters<typeof put>[1], {
        ...auth,
        access: putOptions.access || options.access,
        addRandomSuffix: false,
        allowOverwrite: options.allowOverwrite ?? true,
        contentType: putOptions.contentType,
      })
      const size = typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : body instanceof Blob
          ? body.size
          : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
            ? body.byteLength
            : Number(putOptions.contentLength) || 0
      const contentType = result.contentType || putOptions.contentType
      const httpMetadata: Record<string, string> = {}
      if (contentType) httpMetadata.contentType = contentType
      return {
        contentType,
        customMetadata: putOptions.customMetadata || {},
        httpEtag: undefined,
        httpMetadata,
        pathname: result.pathname,
        size,
        uploadedAt: new Date(),
        url: result.url,
      }
    },
  }
}

export { createBundledVercelBlobDriver as createDriver }
