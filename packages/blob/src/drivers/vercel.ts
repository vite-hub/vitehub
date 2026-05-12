import { vercelBlob } from "files-sdk/vercel-blob"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"
import type { Adapter, StoredFile, UploadResult } from "files-sdk"

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown, message?: unknown }
  return value?.code === "NotFound" || /not found/i.test(String(value?.message || ""))
}

function mapStoredFile(file: StoredFile): BlobObject {
  return {
    contentType: file.type,
    customMetadata: file.metadata || {},
    httpEtag: file.etag,
    httpMetadata: file.type ? { contentType: file.type } : {},
    pathname: file.key,
    size: file.size,
    uploadedAt: file.lastModified ? new Date(file.lastModified) : new Date(),
  }
}

function mapUploadResult(result: UploadResult, options: BlobPutOptions): BlobObject {
  const contentType = result.contentType || options.contentType
  return {
    contentType,
    customMetadata: options.customMetadata || {},
    httpEtag: result.etag,
    httpMetadata: contentType ? { contentType } : {},
    pathname: result.key,
    size: result.size,
    uploadedAt: result.lastModified ? new Date(result.lastModified) : new Date(),
  }
}

function createAdapter(options: ResolvedVercelBlobStoreConfig, access = options.access): Adapter {
  return vercelBlob({
    ...options,
    access,
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite ?? true,
  })
}

export function createDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  const adapter = createAdapter(options)
  return {
    name: "vercel-blob",
    options,
    async delete(pathnames) {
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(async pathname => {
        try {
          await adapter.delete(pathname)
        }
        catch (error) {
          if (!isNotFound(error)) throw error
        }
      }))
    },
    async get(pathname) {
      try {
        return await adapter.download(pathname).then(file => file.blob())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async getArrayBuffer(pathname) {
      try {
        return await adapter.download(pathname).then(file => file.arrayBuffer())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async head(pathname) {
      try {
        return mapStoredFile(await adapter.head(pathname))
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const result = await adapter.list({
        cursor: listOptions.cursor,
        limit: listOptions.limit ?? 1000,
        prefix: listOptions.prefix,
      })
      return {
        blobs: result.items.map(mapStoredFile),
        cursor: result.cursor,
        hasMore: Boolean(result.cursor),
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const uploadOptions = {
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        metadata: putOptions.customMetadata,
      }
      return mapUploadResult(await createAdapter(options, putOptions.access || options.access).upload(pathname, body as never, uploadOptions), putOptions)
    },
  }
}
