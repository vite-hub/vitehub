import { r2 } from "files-sdk/r2"

import { getActiveCloudflareBinding } from "../runtime/state.ts"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"
import type { Adapter, StoredFile, UploadResult } from "files-sdk"

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

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown, message?: unknown }
  return value?.code === "NotFound" || /not found|object not found/i.test(String(value?.message || ""))
}

function getBucket(options: ResolvedCloudflareR2BlobStoreConfig) {
  const binding = getActiveCloudflareBinding<any>(options.binding)
    || (globalThis as any).__env__?.[options.binding]
    || (globalThis as any)[options.binding]

  if (!binding) {
    throw new Error(`R2 binding "${options.binding}" not found`)
  }

  return {
    ...binding,
    async get(key: string) {
      const object = await binding.get(key)
      if (object && !("body" in object) && typeof object.arrayBuffer === "function") {
        return {
          ...object,
          body: new ReadableStream({
            async start(controller) {
              controller.enqueue(new Uint8Array(await object.arrayBuffer()))
              controller.close()
            },
          }),
        }
      }
      return object
    },
  }
}

export function createDriver(options: ResolvedCloudflareR2BlobStoreConfig): BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig> {
  function client(): Adapter {
    return r2({
      ...options,
      binding: getBucket(options),
      bucket: options.bucketName,
    } as never)
  }

  return {
    name: "cloudflare-r2",
    options,
    async delete(pathnames) {
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(async pathname => {
        try {
          await client().delete(pathname)
        }
        catch (error) {
          if (!isNotFound(error)) throw error
        }
      }))
    },
    async get(pathname) {
      try {
        return await client().download(pathname).then(file => file.blob())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async getArrayBuffer(pathname) {
      try {
        return await client().download(pathname).then(file => file.arrayBuffer())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async head(pathname) {
      try {
        return mapStoredFile(await client().head(pathname))
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const result = await client().list({
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
      return mapUploadResult(await client().upload(pathname, body as never, {
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        metadata: putOptions.customMetadata,
      }), putOptions)
    },
  }
}
