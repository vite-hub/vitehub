import { toArray } from "@vitehub/internal/arrays"
import { getActiveCloudflareBinding } from "../runtime/state.ts"

import type {
  BlobDriverAdapter,
  BlobListOptions,
  BlobListResult,
  BlobObject,
  BlobPutBody,
  BlobPutOptions,
  ResolvedCloudflareR2BlobStoreConfig,
} from "../types.ts"

interface R2ObjectLike {
  customMetadata?: Record<string, string>
  httpEtag?: string
  httpMetadata?: { contentType?: string }
  key: string
  size: number
  uploaded: Date
}

interface R2GetResultLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>
}

interface R2BucketLike {
  delete(pathname: string): Promise<void>
  get(pathname: string): Promise<R2GetResultLike | null>
  head(pathname: string): Promise<R2ObjectLike | null>
  list(options: {
    cursor?: string
    delimiter?: string
    include?: string[]
    limit?: number
    prefix?: string
  }): Promise<{
    cursor?: string
    delimitedPrefixes?: string[]
    objects: R2ObjectLike[]
    truncated: boolean
  }>
  put(pathname: string, body: BlobPutBody, options: {
    customMetadata?: Record<string, string>
    httpMetadata?: { contentType?: string }
  }): Promise<R2ObjectLike>
}

function mapR2ObjectToBlob(object: R2ObjectLike): BlobObject {
  return {
    contentType: object.httpMetadata?.contentType,
    customMetadata: object.customMetadata || {},
    httpEtag: object.httpEtag,
    httpMetadata: object.httpMetadata || {},
    pathname: object.key,
    size: object.size,
    uploadedAt: object.uploaded,
  }
}

export function createDriver(options: ResolvedCloudflareR2BlobStoreConfig): BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig> {
  function getBucket(): R2BucketLike {
    const binding = getActiveCloudflareBinding<R2BucketLike>(options.binding)
      || (globalThis as any).__env__?.[options.binding]
      || (globalThis as any)[options.binding]

    if (!binding) {
      throw new Error(`R2 binding "${options.binding}" not found`)
    }

    return binding
  }

  return {
    name: "cloudflare-r2",
    options,
    async delete(pathnames) {
      const bucket = getBucket()
      await Promise.all(toArray(pathnames).map(pathname => bucket.delete(pathname)))
    },
    async get(pathname) {
      const object = await getBucket().get(pathname)
      if (!object) {
        return null
      }

      return new Blob([await object.arrayBuffer()], {
        type: object.httpMetadata?.contentType || "application/octet-stream",
      })
    },
    async getArrayBuffer(pathname) {
      const object = await getBucket().get(pathname)
      return object ? object.arrayBuffer() : null
    },
    async head(pathname) {
      const object = await getBucket().head(pathname)
      return object ? mapR2ObjectToBlob(object) : null
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const result = await getBucket().list({
        cursor: listOptions.cursor,
        delimiter: listOptions.folded ? "/" : undefined,
        include: ["customMetadata", "httpMetadata"],
        limit: listOptions.limit ?? 1000,
        prefix: listOptions.prefix,
      })

      return {
        blobs: result.objects.map(mapR2ObjectToBlob),
        cursor: result.truncated ? result.cursor : undefined,
        folders: listOptions.folded ? result.delimitedPrefixes : undefined,
        hasMore: result.truncated,
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const object = await getBucket().put(pathname, body, {
        customMetadata: putOptions.customMetadata,
        httpMetadata: {
          contentType: putOptions.contentType,
        },
      })

      return mapR2ObjectToBlob(object)
    },
  }
}
