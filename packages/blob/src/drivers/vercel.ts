import { toArray } from "../internal/arrays.ts"

import type {
  BlobDriverAdapter,
  BlobListOptions,
  BlobListResult,
  BlobObject,
  BlobPutBody,
  BlobPutOptions,
  ResolvedVercelBlobStoreConfig,
} from "../types.ts"

type VercelPutBlobResult = {
  contentType?: string
  pathname: string
  size?: number
  uploadedAt?: Date
  url: string
}

type VercelListBlobResult = {
  blobs: Array<VercelPutBlobResult>
  cursor?: string
  folders?: string[]
  hasMore: boolean
}

function getContentType(pathname: string): string | undefined {
  return pathname.endsWith(".json") ? "application/json; charset=utf-8" : undefined
}

function mapVercelBlobToBlob(blob: VercelPutBlobResult): BlobObject {
  return {
    contentType: blob.contentType || getContentType(blob.pathname),
    customMetadata: {},
    httpEtag: undefined,
    httpMetadata: {},
    pathname: blob.pathname,
    size: blob.size,
    uploadedAt: blob.uploadedAt || new Date(),
    url: blob.url,
  }
}

export function createDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  return {
    name: "vercel-blob",
    options,
    async delete(pathnames) {
      const { del, head } = await import("@vercel/blob")
      for (const pathname of toArray(pathnames)) {
        try {
          const current = await head(pathname, { token: options.token })
          if (current) {
            await del(current.url, { token: options.token })
          }
        }
        catch {
          continue
        }
      }
    },
    async get(pathname) {
      const current = await this.head(pathname)
      if (!current?.url) {
        return null
      }

      const response = await fetch(current.url)
      return response.ok ? response.blob() : null
    },
    async getArrayBuffer(pathname) {
      const current = await this.head(pathname)
      if (!current?.url) {
        return null
      }

      const response = await fetch(current.url)
      return response.ok ? await response.arrayBuffer() : null
    },
    async head(pathname) {
      const { head } = await import("@vercel/blob")
      try {
        const result = await head(pathname, { token: options.token })
        return result ? mapVercelBlobToBlob(result as VercelPutBlobResult) : null
      }
      catch {
        return null
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const { list } = await import("@vercel/blob")
      const result = await list({
        cursor: listOptions.cursor,
        limit: listOptions.limit ?? 1000,
        mode: listOptions.folded ? "folded" : "expanded",
        prefix: listOptions.prefix,
        token: options.token,
      }) as VercelListBlobResult

      return {
        blobs: result.blobs.map(mapVercelBlobToBlob),
        cursor: result.cursor,
        folders: result.folders,
        hasMore: result.hasMore,
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      if ((putOptions.access || options.access) === "private") {
        throw new Error("Private access is not yet supported for Vercel Blob.")
      }

      const { put } = await import("@vercel/blob")
      const result = await put(pathname, body as any, {
        access: "public",
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        token: options.token,
      })

      return mapVercelBlobToBlob(result as VercelPutBlobResult)
    },
  }
}
