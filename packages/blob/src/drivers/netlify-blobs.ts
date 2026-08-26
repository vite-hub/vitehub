import { getDeployStore, getStore } from "@vite-hub/netlify-blobs-runtime"
import { toArray } from "@vite-hub/internal/arrays"

import type { BlobDriverAdapter, BlobObject, BlobPutBody, BlobPutOptions, NetlifyBlobsStoreConfig } from "../types.ts"

type StoredMetadata = {
  __contentType?: string
  __lastModified?: number
  __size?: number
  __user?: Record<string, string>
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
    ? getDeployStore({ ...clientOptions, name: options.name })
    : getStore({ ...clientOptions, name: options.name })
}

function toBlobObject(pathname: string, etag: string | undefined, metadata: StoredMetadata = {}): BlobObject {
  const contentType = metadata.__contentType || metadata.contentType
  const customMetadata = metadata.__user || metadata.customMetadata || {}
  const size = metadata.__size ?? metadata.size ?? 0
  const uploadedAt = metadata.__lastModified
    ? new Date(metadata.__lastModified)
    : metadata.uploadedAt ? new Date(metadata.uploadedAt) : new Date(0)
  return {
    contentType,
    customMetadata,
    httpEtag: etag,
    httpMetadata: contentType ? { contentType } : {},
    pathname,
    size,
    uploadedAt,
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
      const result = await store.getWithMetadata(pathname, { consistency: options.consistency, type: "blob" })
      if (!result) return null
      const metadata = result.metadata as StoredMetadata
      return new Blob([result.data], { type: metadata.__contentType || metadata.contentType })
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
      const pages = store.list({
        directories: listOptions.folded,
        paginate: true,
        prefix: listOptions.prefix,
      })
      const offset = Number.parseInt(listOptions.cursor || "0") || 0
      const limit = listOptions.limit ?? 1000
      const selected: Array<{ etag: string, key: string }> = []
      const folders = new Set<string>()
      let seen = 0
      let hasMore = false
      for await (const page of pages) {
        for (const directory of page.directories) folders.add(directory)
        for (const blob of page.blobs) {
          if (seen++ < offset) continue
          if (selected.length === limit) {
            hasMore = true
            break
          }
          selected.push(blob)
        }
        if (hasMore) break
      }
      const blobs = await Promise.all(selected.map(async ({ etag, key }) => {
        const metadata = await store.getMetadata(key, { consistency: options.consistency })
        return toBlobObject(key, etag, metadata?.metadata as StoredMetadata | undefined)
      }))
      const nextOffset = offset + selected.length
      return {
        blobs,
        cursor: hasMore ? String(nextOffset) : undefined,
        folders: listOptions.folded ? [...folders] : undefined,
        hasMore,
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
      const metadata: StoredMetadata = {
        __contentType: contentType,
        __lastModified: uploadedAt.getTime(),
        __size: size,
        __user: putOptions.customMetadata,
      }
      const result = await store.set(pathname, body as Parameters<typeof store.set>[1], {
        metadata,
      })
      return {
        ...toBlobObject(pathname, result.etag, metadata),
      }
    },
  }
}
