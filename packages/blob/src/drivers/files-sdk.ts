import { toArray } from "@vite-hub/internal/arrays"
import { importOptionalPeer } from "../internal/optional-peer.ts"

import type { BlobDriverAdapter, BlobListOptions, BlobListResult, BlobObject, BlobPutBody, BlobPutOptions, ResolvedBlobStoreConfig } from "../types.ts"
import type { Adapter, Files, StoredFile, UploadResult } from "files-sdk"

type FilesCtor = typeof import("files-sdk").Files
type FilesInstance = Files<Adapter>
type FoldedCursor = { index: number, providerCursor?: string }

async function loadFiles(): Promise<FilesCtor> {
  return (await importOptionalPeer(() => import("files-sdk"), "files-sdk", "files")).Files
}

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown, message?: unknown }
  return value?.code === "NotFound" || /not found|object not found/i.test(String(value?.message || ""))
}

function encodeFoldedCursor(value: FoldedCursor) {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

function decodeFoldedCursor(cursor: string | undefined): FoldedCursor {
  const decoded = Buffer.from(cursor || "", "base64url").toString("utf8")
  const index = Number.parseInt(decoded || "0")
  if (Number.isFinite(index)) {
    return { index }
  }

  const parsed = JSON.parse(decoded) as Partial<FoldedCursor>
  return {
    index: typeof parsed.index === "number" && Number.isFinite(parsed.index) ? parsed.index : 0,
    providerCursor: parsed.providerCursor,
  }
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

function mapUploadResult(result: UploadResult, fallback: BlobPutOptions): BlobObject {
  const contentType = result.contentType || fallback.contentType
  return {
    contentType,
    customMetadata: fallback.customMetadata || {},
    httpEtag: result.etag,
    httpMetadata: contentType ? { contentType } : {},
    pathname: result.key,
    size: result.size,
    uploadedAt: result.lastModified ? new Date(result.lastModified) : new Date(),
  }
}

async function getUploadUrl(client: FilesInstance, pathname: string): Promise<string | undefined> {
  try {
    return await client.url(pathname)
  }
  catch {
    return undefined
  }
}

export function createFilesSdkDriver<TOptions extends ResolvedBlobStoreConfig>(
  options: TOptions,
  createAdapter: (options: TOptions, putOptions?: BlobPutOptions) => Adapter | Promise<Adapter>,
  FilesConstructor?: FilesCtor,
): BlobDriverAdapter<TOptions> {
  let filesPromise: Promise<FilesInstance> | undefined

  async function createFiles(putOptions?: BlobPutOptions) {
    const Files = FilesConstructor ?? await loadFiles()
    return new Files({ adapter: await (putOptions ? createAdapter(options, putOptions) : createAdapter(options)) }) as FilesInstance
  }

  async function files(putOptions?: BlobPutOptions) {
    if (putOptions?.access && options.driver === "vercel-blob" && putOptions.access !== options.access) {
      return await createFiles(putOptions)
    }

    filesPromise ||= createFiles()
    return await filesPromise
  }

  return {
    name: options.driver,
    options,
    async delete(pathnames) {
      const client = await files()
      await Promise.all(toArray(pathnames).map(async pathname => {
        try {
          await client.delete(pathname)
        }
        catch (error) {
          if (!isNotFound(error)) throw error
        }
      }))
    },
    async get(pathname) {
      try {
        return await (await files()).download(pathname).then(file => file.blob())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async getArrayBuffer(pathname) {
      try {
        return await (await files()).download(pathname).then(file => file.arrayBuffer())
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async head(pathname) {
      try {
        return mapStoredFile(await (await files()).head(pathname))
      }
      catch (error) {
        if (isNotFound(error)) return null
        throw error
      }
    },
    async list(listOptions: BlobListOptions = {}): Promise<BlobListResult> {
      if (listOptions.folded) {
        const client = await files()
        const prefix = listOptions.prefix || ""
        const limit = listOptions.limit ?? 1000
        const initialCursor = decodeFoldedCursor(listOptions.cursor)
        const folders = new Set<string>()
        const blobs: BlobObject[] = []
        let providerCursor = initialCursor.providerCursor
        let start = initialCursor.index
        let nextCursor: string | undefined

        while (blobs.length < limit) {
          let result
          try {
            result = await client.list({
              cursor: providerCursor,
              limit: 1000,
              prefix: listOptions.prefix,
            })
          }
          catch (error) {
            if (error instanceof Error && /ENOTDIR/.test(error.message)) {
              throw Object.assign(error, { code: "ENOTDIR" })
            }
            throw error
          }

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

          if (blobs.length >= limit) {
            nextCursor = consumed < result.items.length
              ? encodeFoldedCursor({ index: consumed, providerCursor })
              : result.cursor ? encodeFoldedCursor({ index: 0, providerCursor: result.cursor }) : undefined
            break
          }
          if (consumed < result.items.length) {
            nextCursor = encodeFoldedCursor({ index: consumed, providerCursor })
            break
          }
          if (!result.cursor) {
            nextCursor = undefined
            break
          }
          providerCursor = result.cursor
          start = 0
        }

        return {
          blobs,
          cursor: nextCursor,
          folders: [...folders].sort((left, right) => left.localeCompare(right)),
          hasMore: Boolean(nextCursor),
        }
      }

      let result
      try {
        result = await (await files()).list({
          cursor: listOptions.cursor,
          limit: listOptions.limit ?? 1000,
          prefix: listOptions.prefix,
        })
      }
      catch (error) {
        if (error instanceof Error && /ENOTDIR/.test(error.message)) {
          throw Object.assign(error, { code: "ENOTDIR" })
        }
        throw error
      }

      return {
        blobs: result.items.map(mapStoredFile),
        cursor: result.cursor,
        hasMore: Boolean(result.cursor),
      }
    },
    async put(pathname: string, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      const client = await files(putOptions)
      const uploadOptions = {
        contentLength: putOptions.contentLength,
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        metadata: putOptions.customMetadata,
      }
      const result = await client.upload(pathname, body as never, uploadOptions)

      return {
        ...mapUploadResult(result, putOptions),
        pathname: result.key,
        contentType: result.contentType || putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        url: await getUploadUrl(client, result.key),
      }
    },
  }
}
