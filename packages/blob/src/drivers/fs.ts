import { fs } from "files-sdk/fs"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedFsBlobStoreConfig } from "../types.ts"
import type { Adapter, StoredFile, UploadResult } from "files-sdk"

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown, message?: unknown }
  return value?.code === "NotFound" || /not found/i.test(String(value?.message || ""))
}

function encodeCursor(value: number) {
  return Buffer.from(String(value)).toString("base64url")
}

function decodeCursor(cursor: string | undefined) {
  const parsed = Number.parseInt(Buffer.from(cursor || "", "base64url").toString("utf8") || "0")
  return Number.isFinite(parsed) ? parsed : 0
}

function mapStoredFile(file: StoredFile): BlobObject {
  return {
    contentType: file.type,
    customMetadata: file.metadata || {},
    httpEtag: file.etag,
    httpMetadata: file.type ? { contentType: file.type } : {},
    pathname: file.key,
    size: file.size,
    uploadedAt: file.lastModified ? new Date(file.lastModified) : new Date(),
  }
}

function mapUploadResult(result: UploadResult, options: BlobPutOptions): BlobObject {
  const contentType = result.contentType || options.contentType
  return {
    contentType,
    customMetadata: options.customMetadata || {},
    httpEtag: result.etag,
    httpMetadata: contentType ? { contentType } : {},
    pathname: result.key,
    size: result.size,
    uploadedAt: result.lastModified ? new Date(result.lastModified) : new Date(),
  }
}

export function createDriver(options: ResolvedFsBlobStoreConfig): BlobDriverAdapter<ResolvedFsBlobStoreConfig> {
  const adapter: Adapter = fs({
    ...options,
    root: options.base,
  })

  return {
    name: "fs",
    options,
    async delete(pathnames) {
      await Promise.all((Array.isArray(pathnames) ? pathnames : [pathnames]).map(async pathname => {
        try {
          await adapter.delete(pathname)
        }
        catch (error) {
          if (!isNotFound(error)) throw error
        }
      }))
    },
    async get(pathname) {
      try {
        return await adapter.download(pathname).then(file => file.blob())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async getArrayBuffer(pathname) {
      try {
        return await adapter.download(pathname).then(file => file.arrayBuffer())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async head(pathname) {
      try {
        return mapStoredFile(await adapter.head(pathname))
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      let result
      try {
        result = await adapter.list({
          cursor: listOptions.folded ? undefined : listOptions.cursor,
          limit: listOptions.folded ? 1000 : listOptions.limit ?? 1000,
          prefix: listOptions.prefix,
        })
      }
      catch (error) {
        if (error instanceof Error && /ENOTDIR/.test(error.message)) {
          throw Object.assign(error, { code: "ENOTDIR" })
        }
        throw error
      }

      if (listOptions.folded) {
        const prefix = listOptions.prefix || ""
        const limit = listOptions.limit ?? 1000
        const start = decodeCursor(listOptions.cursor)
        const folders = new Set<string>()
        const blobs: BlobObject[] = []
        let consumed = start

        for (const item of result.items.slice(start)) {
          consumed += 1
          const remainder = item.key.slice(prefix.length).replace(/^\/+/, "")
          const firstSlash = remainder.indexOf("/")
          if (firstSlash !== -1) {
            folders.add(`${prefix.replace(/\/?$/, "/")}${remainder.slice(0, firstSlash + 1)}`)
            continue
          }
          blobs.push(mapStoredFile(item))
          if (blobs.length >= limit) break
        }

        return {
          blobs,
          cursor: consumed < result.items.length ? encodeCursor(consumed) : undefined,
          folders: [...folders].sort((left, right) => left.localeCompare(right)),
          hasMore: consumed < result.items.length,
        }
      }

      return {
        blobs: result.items.map(mapStoredFile),
        cursor: result.cursor,
        hasMore: Boolean(result.cursor),
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      return mapUploadResult(await adapter.upload(pathname, body as never, {
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        metadata: putOptions.customMetadata,
      }), putOptions)
    },
  }
}
