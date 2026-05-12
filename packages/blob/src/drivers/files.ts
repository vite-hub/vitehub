import { toArray } from "@vitehub/internal/arrays"
import { getActiveCloudflareBinding } from "../runtime/state.ts"

import type {
  BlobDriverAdapter,
  BlobListOptions,
  BlobListResult,
  BlobObject,
  BlobPutBody,
  BlobPutOptions,
  ResolvedBlobStoreConfig,
  ResolvedCloudflareR2BlobStoreConfig,
  ResolvedFsBlobStoreConfig,
  ResolvedVercelBlobStoreConfig,
} from "../types.ts"
import type { Adapter, Files, StoredFile, UploadResult } from "files-sdk"

type FilesCtor = typeof import("files-sdk").Files
type FilesInstance = Files<Adapter>

async function loadFiles(): Promise<FilesCtor> {
  return (await import("files-sdk")).Files
}

function isNotFound(error: unknown): boolean {
  const value = error as { code?: unknown, message?: unknown }
  return value?.code === "NotFound" || /not found|object not found/i.test(String(value?.message || ""))
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

function getCloudflareBinding(options: ResolvedCloudflareR2BlobStoreConfig) {
  const binding = getActiveCloudflareBinding(options.binding)
    || (globalThis as any).__env__?.[options.binding]
    || (globalThis as any)[options.binding]

  if (!binding) {
    throw new Error(`R2 binding "${options.binding}" not found`)
  }

  return binding
}

async function createAdapter(options: ResolvedBlobStoreConfig, putOptions: BlobPutOptions = {}): Promise<Adapter> {
  switch (options.driver) {
    case "akamai":
      return (await import("files-sdk/akamai")).akamai(options)
    case "azure":
      return (await import("files-sdk/azure")).azure(options)
    case "box":
      return (await import("files-sdk/box")).box(options)
    case "cloudflare-r2":
      return (await import("files-sdk/r2")).r2({
        ...options,
        binding: getCloudflareBinding(options),
        bucket: options.bucketName,
      } as never)
    case "digitalocean-spaces":
      return (await import("files-sdk/digitalocean-spaces")).digitaloceanSpaces(options)
    case "dropbox":
      return (await import("files-sdk/dropbox")).dropbox(options)
    case "fs":
      return (await import("files-sdk/fs")).fs({
        ...(options as ResolvedFsBlobStoreConfig),
        root: options.base,
      })
    case "gcs":
      return (await import("files-sdk/gcs")).gcs(options)
    case "google-drive":
      return (await import("files-sdk/google-drive")).googleDrive(options)
    case "hetzner":
      return (await import("files-sdk/hetzner")).hetzner(options)
    case "minio":
      return (await import("files-sdk/minio")).minio(options)
    case "netlify-blobs":
      return (await import("files-sdk/netlify-blobs")).netlifyBlobs(options)
    case "onedrive":
      return (await import("files-sdk/onedrive")).onedrive(options)
    case "s3":
      return (await import("files-sdk/s3")).s3(options)
    case "storj":
      return (await import("files-sdk/storj")).storj(options)
    case "supabase":
      return (await import("files-sdk/supabase")).supabase(options)
    case "uploadthing":
      return (await import("files-sdk/uploadthing")).uploadthing(options)
    case "vercel-blob":
      return (await import("files-sdk/vercel-blob")).vercelBlob({
        ...(options as ResolvedVercelBlobStoreConfig),
        access: putOptions.access || options.access,
        addRandomSuffix: false,
        allowOverwrite: options.allowOverwrite ?? true,
      })
  }
}

async function createFiles(options: ResolvedBlobStoreConfig, putOptions?: BlobPutOptions): Promise<FilesInstance> {
  const Files = await loadFiles()
  return new Files({ adapter: await createAdapter(options, putOptions) }) as FilesInstance
}

export function createDriver(options: ResolvedBlobStoreConfig): BlobDriverAdapter<ResolvedBlobStoreConfig> {
  let filesPromise: Promise<FilesInstance> | undefined

  async function files(putOptions?: BlobPutOptions) {
    if (putOptions?.access && options.driver === "vercel-blob" && putOptions.access !== options.access) {
      return await createFiles(options, putOptions)
    }

    filesPromise ||= createFiles(options)
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
      let result
      try {
        result = await (await files()).list({
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
      const client = await files(putOptions)
      const uploadOptions = {
        contentType: putOptions.contentType || (body instanceof Blob ? body.type : undefined),
        metadata: putOptions.customMetadata,
      }
      const result = await client.upload(pathname, body as never, uploadOptions)

      return {
        ...mapUploadResult(result, putOptions),
        pathname: result.key,
        contentType: result.contentType || putOptions.contentType || (body instanceof Blob ? body.type : undefined),
      }
    },
  }
}
