import { createError } from "h3"
import { getContentType, normalizePutBody } from "../utils.ts"
import type { BlobDriver, BlobPutBody } from "./types.ts"
import type { ResolvedVercelBlobConfig } from "../../types.ts"
import type { BlobListOptions, BlobListResult, BlobObject, BlobPutOptions } from "../types.ts"

type VercelBlobRecord = {
  contentType?: string
  pathname: string
  size?: number
  uploadedAt?: Date
  url?: string
}

type VercelListResult = {
  blobs: VercelBlobRecord[]
  cursor?: string
  folders?: string[]
  hasMore: boolean
}

const loadVercelBlobSdk = (): Promise<typeof import("@vercel/blob")> => import("@vercel/blob")

function mapVercelBlobToBlob(blob: VercelBlobRecord): BlobObject {
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

export function createVercelBlobDriver(options: ResolvedVercelBlobConfig): BlobDriver<ResolvedVercelBlobConfig> {
  const readToken = (): string | undefined => options.token || process.env.BLOB_READ_WRITE_TOKEN

  return {
    name: "vercel-blob",
    options,
    async list(listOptions?: BlobListOptions): Promise<BlobListResult> {
      const sdk = await loadVercelBlobSdk()
      const result = await sdk.list({
        cursor: listOptions?.cursor,
        limit: listOptions?.limit ?? 1000,
        mode: listOptions?.folded ? "folded" : "expanded",
        prefix: listOptions?.prefix,
        token: readToken(),
      }) as VercelListResult

      return {
        blobs: result.blobs.map(mapVercelBlobToBlob),
        cursor: result.cursor,
        folders: result.folders,
        hasMore: result.hasMore,
      }
    },
    async get(pathname: string): Promise<Blob | null> {
      const metadata = await this.head(pathname)
      if (!metadata?.url) return null

      const response = await fetch(metadata.url)
      if (response.status === 404) return null
      if (!response.ok) throw createError({ message: `Vercel Blob fetch failed: ${response.status} ${response.statusText}`, statusCode: response.status })
      return await response.blob()
    },
    async getArrayBuffer(pathname: string): Promise<ArrayBuffer | null> {
      const metadata = await this.head(pathname)
      if (!metadata?.url) return null

      const response = await fetch(metadata.url)
      if (response.status === 404) return null
      if (!response.ok) throw createError({ message: `Vercel Blob fetch failed: ${response.status} ${response.statusText}`, statusCode: response.status })
      return await response.arrayBuffer()
    },
    async put(pathname: string, body: BlobPutBody, putOptions?: BlobPutOptions): Promise<BlobObject> {
      if (putOptions?.access === "private") {
        throw createError({
          message: "Private access is not supported for Vercel Blob in @vitehub/blob.",
          statusCode: 400,
        })
      }

      const sdk = await loadVercelBlobSdk()
      const result = await sdk.put(pathname, normalizePutBody(body), {
        access: "public",
        contentType: putOptions?.contentType || (body instanceof Blob ? body.type : undefined) || getContentType(pathname),
        token: readToken(),
      })
      return mapVercelBlobToBlob(result)
    },
    async head(pathname: string): Promise<BlobObject | null> {
      const sdk = await loadVercelBlobSdk()
      try {
        const result = await sdk.head(decodeURIComponent(pathname), { token: readToken() })
        return result ? mapVercelBlobToBlob(result) : null
      }
      catch (error) {
        if (error instanceof sdk.BlobNotFoundError) return null
        throw error
      }
    },
    async delete(pathnames: string | string[]): Promise<void> {
      const sdk = await loadVercelBlobSdk()
      for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) {
        const metadata = await this.head(pathname)
        if (metadata?.url) await sdk.del(metadata.url, { token: readToken() })
      }
    },
  }
}
