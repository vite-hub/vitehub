import { getContentType } from "../utils.ts"
import type { BlobDriver, BlobPutBody } from "./types.ts"
import type { ResolvedCloudflareR2BlobConfig } from "../../types.ts"
import type { BlobListOptions, BlobListResult, BlobObject, BlobPutOptions } from "../types.ts"

type R2LikeObject = {
  arrayBuffer(): Promise<ArrayBuffer>
  customMetadata?: Record<string, string>
  httpEtag?: string
  httpMetadata?: Record<string, string>
  key: string
  size?: number
  uploaded?: Date
}

type R2LikeBucket = {
  delete(pathname: string): Promise<void>
  get(pathname: string): Promise<R2LikeObject | null>
  head(pathname: string): Promise<R2LikeObject | null>
  list(options?: Record<string, unknown>): Promise<{
    cursor?: string
    delimitedPrefixes?: string[]
    objects: R2LikeObject[]
    truncated: boolean
  }>
  put(pathname: string, body: BlobPutBody, options?: Record<string, unknown>): Promise<R2LikeObject>
}

function mapR2ObjectToBlob(object: R2LikeObject): BlobObject {
  return {
    contentType: object.httpMetadata?.contentType || getContentType(object.key),
    customMetadata: object.customMetadata || {},
    httpEtag: object.httpEtag,
    httpMetadata: object.httpMetadata || {},
    pathname: object.key,
    size: object.size,
    uploadedAt: object.uploaded || new Date(),
  }
}

function getBucket(options: ResolvedCloudflareR2BlobConfig): R2LikeBucket {
  const runtimeGlobals = globalThis as typeof globalThis & Record<string, unknown> & {
    __env__?: Record<string, unknown>
  }
  const bucket = runtimeGlobals[options.binding] || runtimeGlobals.__env__?.[options.binding]
  if (!bucket) throw new Error(`R2 binding "${options.binding}" not found`)
  return bucket as R2LikeBucket
}

export function createCloudflareR2Driver(options: ResolvedCloudflareR2BlobConfig): BlobDriver<ResolvedCloudflareR2BlobConfig> {
  return {
    name: "cloudflare-r2",
    options,
    async list(listOptions?: BlobListOptions): Promise<BlobListResult> {
      const result = await getBucket(options).list({
        cursor: listOptions?.cursor,
        delimiter: listOptions?.folded ? "/" : undefined,
        include: ["httpMetadata", "customMetadata"],
        limit: listOptions?.limit ?? 1000,
        prefix: listOptions?.prefix,
      })

      return {
        blobs: result.objects.map(mapR2ObjectToBlob),
        cursor: result.truncated ? result.cursor : undefined,
        folders: listOptions?.folded ? result.delimitedPrefixes : undefined,
        hasMore: result.truncated,
      }
    },
    async get(pathname: string): Promise<Blob | null> {
      const object = await getBucket(options).get(decodeURIComponent(pathname))
      return object
        ? new Blob([await object.arrayBuffer()], { type: object.httpMetadata?.contentType || getContentType(pathname) })
        : null
    },
    async getArrayBuffer(pathname: string): Promise<ArrayBuffer | null> {
      const object = await getBucket(options).get(decodeURIComponent(pathname))
      return object ? await object.arrayBuffer() : null
    },
    async put(pathname: string, body: BlobPutBody, putOptions?: BlobPutOptions): Promise<BlobObject> {
      const contentType = putOptions?.contentType || (body instanceof Blob ? body.type : undefined) || getContentType(pathname)
      const object = await getBucket(options).put(pathname, body, {
        customMetadata: putOptions?.customMetadata,
        httpMetadata: { contentType },
      })
      return mapR2ObjectToBlob(object)
    },
    async head(pathname: string): Promise<BlobObject | null> {
      const object = await getBucket(options).head(decodeURIComponent(pathname))
      return object ? mapR2ObjectToBlob(object) : null
    },
    async delete(pathnames: string | string[]): Promise<void> {
      const paths = Array.isArray(pathnames) ? pathnames : [pathnames]
      await Promise.all(paths.map(pathname => getBucket(options).delete(decodeURIComponent(pathname))))
    },
  }
}
