import { getActiveCloudflareBinding } from "../runtime/state.ts"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"

interface R2ObjectLike {
  arrayBuffer?: () => Promise<ArrayBuffer>
  body?: ReadableStream
  customMetadata?: Record<string, string>
  httpEtag?: string
  httpMetadata?: { contentType?: string }
  key: string
  size?: number
  uploaded?: Date
}

interface R2BucketLike {
  delete(key: string): Promise<void>
  get(key: string): Promise<R2ObjectLike | null>
  head(key: string): Promise<R2ObjectLike | null>
  list(options?: { cursor?: string, delimiter?: string, include?: string[], limit?: number, prefix?: string }): Promise<{ cursor?: string, delimitedPrefixes?: string[], objects: R2ObjectLike[], truncated?: boolean }>
  put(key: string, value: BlobPutBody, options?: { customMetadata?: Record<string, string>, httpMetadata?: { contentType?: string } }): Promise<R2ObjectLike>
}

function getBucket(options: ResolvedCloudflareR2BlobStoreConfig): R2BucketLike {
  const binding = getActiveCloudflareBinding<R2BucketLike>(options.binding)
    || (globalThis as any).__env__?.[options.binding]
    || (globalThis as any)[options.binding]

  if (!binding) {
    throw new Error(`R2 binding "${options.binding}" not found`)
  }

  return binding
}

function mapObject(object: R2ObjectLike): BlobObject {
  const contentType = object.httpMetadata?.contentType
  return {
    contentType,
    customMetadata: object.customMetadata || {},
    httpEtag: object.httpEtag,
    httpMetadata: contentType ? { contentType } : {},
    pathname: object.key,
    size: object.size,
    uploadedAt: object.uploaded || new Date(),
  }
}

async function readArrayBuffer(object: R2ObjectLike): Promise<ArrayBuffer> {
  if (typeof object.arrayBuffer === "function") {
    return await object.arrayBuffer()
  }
  if (object.body) {
    return await new Response(object.body).arrayBuffer()
  }
  return new ArrayBuffer(0)
}

export function createDriver(options: ResolvedCloudflareR2BlobStoreConfig): BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig> {
  return {
    name: "cloudflare-r2",
    options,
    async delete(pathnames) {
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(pathname => getBucket(options).delete(pathname)))
    },
    async get(pathname) {
      const object = await getBucket(options).get(pathname)
      if (!object) return null
      const bytes = await readArrayBuffer(object)
      return new Blob([bytes], { type: object.httpMetadata?.contentType || "" })
    },
    async getArrayBuffer(pathname) {
      const object = await getBucket(options).get(pathname)
      return object ? await readArrayBuffer(object) : null
    },
    async head(pathname) {
      const object = await getBucket(options).head(pathname)
      return object ? mapObject(object) : null
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const result = await getBucket(options).list({
        cursor: listOptions.cursor,
        delimiter: listOptions.folded ? "/" : undefined,
        include: ["customMetadata", "httpMetadata"],
        limit: listOptions.limit ?? 1000,
        prefix: listOptions.prefix,
      })
      return {
        blobs: result.objects.map(mapObject),
        cursor: result.truncated ? result.cursor : undefined,
        folders: listOptions.folded ? result.delimitedPrefixes?.sort((left, right) => left.localeCompare(right)) : undefined,
        hasMore: Boolean(result.truncated || result.cursor),
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const object = await getBucket(options).put(pathname, body, {
        customMetadata: putOptions.customMetadata,
        httpMetadata: {
          contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        },
      })
      return mapObject(object)
    },
  }
}
