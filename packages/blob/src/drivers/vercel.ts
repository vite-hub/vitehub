import { toArray } from "@vitehub/internal/arrays"

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
  downloadUrl?: string
  etag?: string
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

function getAccessFromUrl(url: string | undefined): "private" | "public" | undefined {
  if (!url) {
    return
  }

  if (url.includes(".private.blob.vercel-storage.com")) {
    return "private"
  }

  if (url.includes(".public.blob.vercel-storage.com")) {
    return "public"
  }
}

function shouldRetryPrivate(error: unknown): boolean {
  return error instanceof Error && (error.name === "HTTPError" || /private store|public access/i.test(error.message))
}

async function loadVercelBlob() {
  const preloaded = (globalThis as typeof globalThis & { __vitehubVercelBlob?: typeof import("@vercel/blob") }).__vitehubVercelBlob
  if (preloaded) return preloaded

  const importVercelBlob = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@vercel/blob")>
  const specifier = "@vercel/blob"
  try {
    return await importVercelBlob(specifier)
  }
  catch (error) {
    if (!(error instanceof TypeError) || !/dynamic import callback/i.test(error.message)) throw error
    return await import(specifier)
  }
}

function mapVercelBlobToBlob(blob: VercelPutBlobResult): BlobObject {
  return {
    contentType: blob.contentType || getContentType(blob.pathname),
    customMetadata: {},
    httpEtag: blob.etag,
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
      const { del, head } = await loadVercelBlob()
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

      const { get } = await loadVercelBlob()
      const result = await get(current.url, {
        access: getAccessFromUrl(current.url) || options.access,
        token: options.token,
      })

      return result?.statusCode === 200 ? await new Response(result.stream).blob() : null
    },
    async getArrayBuffer(pathname) {
      const current = await this.head(pathname)
      if (!current?.url) {
        return null
      }

      const { get } = await loadVercelBlob()
      const result = await get(current.url, {
        access: getAccessFromUrl(current.url) || options.access,
        token: options.token,
      })

      return result?.statusCode === 200 ? await new Response(result.stream).arrayBuffer() : null
    },
    async head(pathname) {
      const { head } = await loadVercelBlob()
      try {
        const result = await head(pathname, { token: options.token })
        return result ? mapVercelBlobToBlob(result as VercelPutBlobResult) : null
      }
      catch {
        return null
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const { list } = await loadVercelBlob()
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
      const { put } = await loadVercelBlob()
      const access = putOptions.access || options.access
      const putInput = {
        access,
        addRandomSuffix: false,
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        token: options.token,
      } as const

      let result: unknown
      try {
        result = await put(pathname, body as any, putInput)
      }
      catch (error) {
        if (access !== "public" || !shouldRetryPrivate(error)) {
          throw error
        }

        result = await put(pathname, body as any, {
          ...putInput,
          access: "private",
        })
      }

      return mapVercelBlobToBlob(result as VercelPutBlobResult)
    },
  }
}
