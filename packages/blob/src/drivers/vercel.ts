import { importOptionalPeer } from "../internal/optional-peer.ts"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"

type VercelBlobModule = typeof import("@vercel/blob")

async function loadVercelBlob() {
  return await importOptionalPeer<VercelBlobModule>("@vercel/blob", "vercel-blob")
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message)
}

function commandOptions(options: ResolvedVercelBlobStoreConfig) {
  return { token: options.token }
}

function mapBlob(blob: {
  contentType?: string | null
  etag?: string
  pathname: string
  size?: number | null
  uploadedAt?: Date
  url?: string
}, fallback: BlobPutOptions = {}): BlobObject {
  const contentType = blob.contentType || fallback.contentType
  return {
    contentType,
    customMetadata: fallback.customMetadata || {},
    httpEtag: blob.etag,
    httpMetadata: contentType ? { contentType } : {},
    pathname: blob.pathname,
    size: blob.size ?? undefined,
    uploadedAt: blob.uploadedAt || new Date(),
    url: blob.url,
  }
}

export function createDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  return {
    name: "vercel-blob",
    options,
    async delete(pathnames) {
      const { del } = await loadVercelBlob()
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(pathname => del(pathname, commandOptions(options))))
    },
    async get(pathname) {
      const bytes = await this.getArrayBuffer(pathname)
      return bytes ? new Blob([bytes]) : null
    },
    async getArrayBuffer(pathname) {
      const { get } = await loadVercelBlob()
      const result = await get(pathname, {
        access: options.access || "public",
        ...commandOptions(options),
      })
      return result?.stream ? await new Response(result.stream).arrayBuffer() : null
    },
    async head(pathname) {
      const { head } = await loadVercelBlob()
      try {
        return mapBlob(await head(pathname, commandOptions(options)))
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      const { list } = await loadVercelBlob()
      const result = await list({
        cursor: listOptions.cursor,
        limit: listOptions.limit ?? 1000,
        mode: listOptions.folded ? "folded" : undefined,
        prefix: listOptions.prefix,
        ...commandOptions(options),
      })
      return {
        blobs: result.blobs.map(blob => mapBlob(blob)),
        cursor: result.cursor,
        folders: "folders" in result ? result.folders : undefined,
        hasMore: result.hasMore,
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const { put } = await loadVercelBlob()
      return mapBlob(await put(pathname, body as Parameters<typeof put>[1], {
        access: putOptions.access || options.access || "public",
        addRandomSuffix: false,
        allowOverwrite: options.allowOverwrite ?? true,
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        ...commandOptions(options),
      }), putOptions)
    },
  }
}
