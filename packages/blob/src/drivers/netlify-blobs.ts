import { getDeployStore, getStore } from "@netlify/blobs"
import { toArray } from "@vite-hub/internal/arrays"

import type { BlobDriverAdapter, BlobObject, BlobPutBody, BlobPutOptions, NetlifyBlobsStoreConfig } from "../types.ts"

type StoredMetadata = {
  contentType?: string
  customMetadata?: Record<string, string>
  size?: number
  uploadedAt?: string
}

function createStore(options: NetlifyBlobsStoreConfig) {
  const clientOptions = {
    consistency: options.consistency,
    siteID: options.siteID,
    token: options.token,
  }
  return options.deployScoped
    ? getDeployStore(options.name)
    : getStore({ ...clientOptions, name: options.name })
}

function toBlobObject(pathname: string, etag: string | undefined, metadata: StoredMetadata = {}): BlobObject {
  return {
    contentType: metadata.contentType,
    customMetadata: metadata.customMetadata || {},
    httpEtag: etag,
    httpMetadata: metadata.contentType ? { contentType: metadata.contentType } : {},
    pathname,
    size: metadata.size || 0,
    uploadedAt: metadata.uploadedAt ? new Date(metadata.uploadedAt) : new Date(0),
  }
}

export function createDriver(options: NetlifyBlobsStoreConfig): BlobDriverAdapter<NetlifyBlobsStoreConfig> {
  const store = createStore(options)
  return {
    name: options.driver,
    options,
    async delete(pathnames) {
      await Promise.all(toArray(pathnames).map(pathname => store.delete(pathname)))
    },
    async get(pathname) {
      return await store.get(pathname, { consistency: options.consistency, type: "blob" })
    },
    async getArrayBuffer(pathname) {
      const result = await store.getWithMetadata(pathname, { consistency: options.consistency, type: "arrayBuffer" })
      return result?.data || null
    },
    async head(pathname) {
      const result = await store.getMetadata(pathname, { consistency: options.consistency })
      return result ? toBlobObject(pathname, result.etag, result.metadata as StoredMetadata) : null
    },
    async list(listOptions = {}) {
      const result = await store.list({
        directories: listOptions.folded,
        prefix: listOptions.prefix,
      })
      const offset = Number.parseInt(listOptions.cursor || "0") || 0
      const limit = listOptions.limit ?? 1000
      const selected = result.blobs.slice(offset, offset + limit)
      const blobs = await Promise.all(selected.map(async ({ etag, key }) => {
        const metadata = await store.getMetadata(key, { consistency: options.consistency })
        return toBlobObject(key, etag, metadata?.metadata as StoredMetadata | undefined)
      }))
      const nextOffset = offset + selected.length
      return {
        blobs,
        cursor: nextOffset < result.blobs.length ? String(nextOffset) : undefined,
        folders: listOptions.folded ? result.directories : undefined,
        hasMore: nextOffset < result.blobs.length,
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const contentType = putOptions.contentType || (body instanceof Blob ? body.type : undefined)
      const size = typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : body instanceof Blob
          ? body.size
          : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
            ? body.byteLength
            : Number(putOptions.contentLength) || 0
      const uploadedAt = new Date()
      const result = await store.set(pathname, body as Parameters<typeof store.set>[1], {
        metadata: { contentType, customMetadata: putOptions.customMetadata, size, uploadedAt: uploadedAt.toISOString() },
      })
      return {
        ...toBlobObject(pathname, result.etag, { contentType, customMetadata: putOptions.customMetadata, size, uploadedAt: uploadedAt.toISOString() }),
      }
    },
  }
}
