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

function isMissingBlobError(error: unknown) {
  return error instanceof Error && (
    error.name === "BlobNotFoundError"
    || /(?:requested )?blob (?:was )?not found|requested blob does not exist/i.test(error.message)
  )
}

function resolveBlobAccess(url: string, fallback: "private" | "public") {
  try {
    const hostname = new URL(url).hostname
    if (hostname.endsWith(".private.blob.vercel-storage.com")) return "private"
    if (hostname.endsWith(".public.blob.vercel-storage.com")) return "public"
  }
  catch {}
  return fallback
}

export function createBundledVercelBlobDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  const auth = { token: options.token }

  async function read(pathname: string) {
    const abortSignal = options.downloadTimeoutMs && options.downloadTimeoutMs > 0
      ? AbortSignal.timeout(options.downloadTimeoutMs)
      : undefined
    try {
      const metadata = await head(pathname, { ...auth, abortSignal })
      const result = await get(metadata.url, {
        ...auth,
        abortSignal,
        access: resolveBlobAccess(metadata.url, options.access),
      })
      return result ? new Response(result.stream, { headers: result.blob.contentType ? { "content-type": result.blob.contentType } : undefined }) : null
    }
    catch (error) {
      if (isMissingBlobError(error)) return null
      throw error
    }
  }

  return {
    name: options.driver,
    options,
    async delete(pathnames) {
      await del(pathnames, auth)
    },
    async get(pathname) {
      return await (await read(pathname))?.blob() || null
    },
    async getArrayBuffer(pathname) {
      return await (await read(pathname))?.arrayBuffer() || null
    },
    async head(pathname) {
      try {
        return toBlobObject(await head(pathname, auth))
      }
      catch (error) {
        if (isMissingBlobError(error)) return null
        throw error
      }
    },
    async list(listOptions = {}) {
      if (listOptions.folded) {
        const result = await list({
          ...auth,
          cursor: listOptions.cursor,
          limit: listOptions.limit,
          mode: "folded",
          prefix: listOptions.prefix,
        })
        return {
          blobs: result.blobs.map(toBlobObject),
          cursor: result.cursor,
          folders: result.folders,
          hasMore: result.hasMore,
        }
      }
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
      let size = typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : body instanceof Blob
          ? body.size
          : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
            ? body.byteLength
            : Number(putOptions.contentLength) || 0
      let uploadedAt = new Date()
      let httpEtag = (result as typeof result & { etag?: string }).etag
      if (!size) {
        const metadata = await head(result.url, auth)
        size = metadata.size
        uploadedAt = metadata.uploadedAt
        httpEtag ||= metadata.etag
      }
      const contentType = result.contentType || putOptions.contentType
      const httpMetadata: Record<string, string> = {}
      if (contentType) httpMetadata.contentType = contentType
      return {
        contentType,
        customMetadata: putOptions.customMetadata || {},
        httpEtag,
        httpMetadata,
        pathname: result.pathname,
        size,
        uploadedAt,
        url: result.url,
      }
    },
  }
}

export { createBundledVercelBlobDriver as createDriver }
