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

type FoldedCursor = {
  directoriesConsumed: boolean
  index: number
  page: number
}

function decodeCursor(cursor: string | undefined): FoldedCursor {
  if (!cursor) return { directoriesConsumed: false, index: 0, page: 0 }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<FoldedCursor>
    return {
      directoriesConsumed: parsed.directoriesConsumed === true,
      index: typeof parsed.index === "number" && parsed.index >= 0 ? parsed.index : 0,
      page: typeof parsed.page === "number" && parsed.page >= 0 ? parsed.page : 0,
    }
  }
  catch {
    return { directoriesConsumed: false, index: Number.parseInt(cursor) || 0, page: 0 }
  }
}

function encodeCursor(cursor: FoldedCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
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

async function normalizeBody(body: BlobPutBody) {
  if (body instanceof ReadableStream) return await new Response(body as never).arrayBuffer()
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice().buffer
  return body
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
      const cursor = decodeCursor(listOptions.cursor)
      const limit = listOptions.limit ?? 1000
      const selected: Array<{ etag: string, key: string }> = []
      const folders = new Set<string>()
      let hasMore = false
      let nextCursor: FoldedCursor | undefined
      let pageIndex = 0
      for await (const page of pages) {
        if (pageIndex < cursor.page) {
          pageIndex++
          continue
        }
        const startIndex = pageIndex === cursor.page ? cursor.index : 0
        const includeDirectories = pageIndex !== cursor.page || !cursor.directoriesConsumed
        if (page.blobs.length === 0) {
          if (includeDirectories) {
            for (const directory of page.directories) folders.add(directory)
          }
          pageIndex++
          continue
        }
        const consumeDirectories = includeDirectories && selected.length < limit && startIndex < page.blobs.length
        const directoriesConsumed = pageIndex === cursor.page
          ? cursor.directoriesConsumed || consumeDirectories
          : consumeDirectories
        if (consumeDirectories) {
          for (const directory of page.directories) folders.add(directory)
        }
        for (let blobIndex = startIndex; blobIndex < page.blobs.length; blobIndex++) {
          if (selected.length === limit) {
            hasMore = true
            nextCursor = { directoriesConsumed, index: blobIndex, page: pageIndex }
            break
          }
          selected.push(page.blobs[blobIndex]!)
        }
        if (hasMore) break
        pageIndex++
      }
      const blobs = await Promise.all(selected.map(async ({ etag, key }) => {
        const metadata = await store.getMetadata(key, { consistency: options.consistency })
        return toBlobObject(key, etag, metadata?.metadata as StoredMetadata | undefined)
      }))
      return {
        blobs,
        cursor: hasMore && nextCursor ? encodeCursor(nextCursor) : undefined,
        folders: listOptions.folded ? [...folders] : undefined,
        hasMore,
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const normalizedBody = await normalizeBody(body)
      const contentType = putOptions.contentType || (normalizedBody instanceof Blob ? normalizedBody.type : undefined)
      const size = typeof normalizedBody === "string"
        ? new TextEncoder().encode(normalizedBody).byteLength
        : normalizedBody instanceof Blob
          ? normalizedBody.size
          : normalizedBody.byteLength
      const uploadedAt = new Date()
      const metadata: StoredMetadata = {
        __contentType: contentType,
        __lastModified: uploadedAt.getTime(),
        __size: size,
        __user: putOptions.customMetadata,
      }
      const result = await store.set(pathname, normalizedBody, {
        metadata,
      })
      return {
        ...toBlobObject(pathname, result.etag, metadata),
      }
    },
  }
}
