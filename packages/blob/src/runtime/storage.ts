import {
  assertMethod,
  createError,
  readFormData,
  setHeader,
} from "h3"
import { posix as pathPosix } from "node:path"
import { randomUUID } from "node:crypto"
import { ensureBlob } from "./ensure.ts"
import { getContentType } from "./utils.ts"
import type { BlobDriver } from "./drivers/types.ts"
import type {
  BlobBody,
  BlobListOptions,
  BlobObject,
  BlobPutOptions,
  BlobStorage,
  BlobUploadOptions,
} from "./types.ts"
import type { H3Event } from "h3"

function readBlobErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error"
}

function readBlobStatusCode(error: unknown): number {
  const code = (error as { statusCode?: number } | null)?.statusCode
  return typeof code === "number" ? code : 500
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "")
}

function resolvePutPathname(pathname: string, options: Pick<BlobPutOptions, "addRandomSuffix" | "prefix">): string {
  const decoded = decodeURIComponent(pathname)
  const parsed = pathPosix.parse(decoded)
  const dir = parsed.dir === "." ? "" : parsed.dir
  const filename = options.addRandomSuffix
    ? `${parsed.name}-${randomUUID().split("-")[0]}${parsed.ext}`
    : `${parsed.name}${parsed.ext}`
  const resolved = pathPosix.join(dir, filename)

  return normalizePathname(options.prefix ? pathPosix.join(options.prefix, resolved) : resolved)
}

export function createBlobStorage(driver: BlobDriver<unknown>): BlobStorage {
  const blob = {
    driver,
    async list(options?: BlobListOptions) {
      return driver.list({
        limit: 1000,
        ...options,
      })
    },
    async serve(event: H3Event, pathname: string) {
      const decoded = decodeURIComponent(pathname)
      const arrayBuffer = await driver.getArrayBuffer(decoded)
      if (!arrayBuffer) throw createError({ message: "File not found", statusCode: 404 })

      const metadata = await driver.head(decoded)
      const contentType = metadata?.contentType || getContentType(decoded)
      setHeader(event, "Content-Type", contentType)
      setHeader(event, "Content-Length", String(arrayBuffer.byteLength))
      if (metadata?.httpEtag) setHeader(event, "etag", metadata.httpEtag)

      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(arrayBuffer))
          controller.close()
        },
      })
    },
    async get(pathname: string) {
      return driver.get(decodeURIComponent(pathname))
    },
    async put(pathname: string, body: BlobBody, options: BlobPutOptions = {}) {
      const contentType = options.contentType || (body instanceof Blob ? body.type : undefined) || getContentType(pathname)
      const resolvedPathname = resolvePutPathname(pathname, options)

      return driver.put(resolvedPathname, body, {
        access: options.access,
        contentLength: options.contentLength,
        contentType,
        customMetadata: options.customMetadata,
      })
    },
    async head(pathname: string) {
      const metadata = await driver.head(decodeURIComponent(pathname))
      if (!metadata) throw createError({ message: "Blob not found", statusCode: 404 })
      return metadata
    },
    async del(pathnames: string | string[]) {
      const paths = Array.isArray(pathnames) ? pathnames : [pathnames]
      await driver.delete(paths.map(pathname => decodeURIComponent(pathname)))
    },
    async handleUpload(event: H3Event, options: BlobUploadOptions = {}) {
      assertMethod(event, ["POST", "PUT", "PATCH"])

      const resolvedOptions = {
        formKey: "files",
        multiple: true,
        ...options,
      }
      const form = await readFormData(event)
      const entries = form.getAll(resolvedOptions.formKey)
      if (entries.some(entry => !(entry instanceof File))) {
        throw createError({ message: `Form field "${resolvedOptions.formKey}" must contain files`, statusCode: 400 })
      }
      const files = entries as File[]

      if (!files.length) throw createError({ message: "Missing files", statusCode: 400 })
      if (!resolvedOptions.multiple && files.length > 1) {
        throw createError({ message: "Multiple files are not allowed", statusCode: 400 })
      }

      const objects: BlobObject[] = []
      try {
        if (resolvedOptions.ensure) {
          for (const file of files) ensureBlob(file, resolvedOptions.ensure)
        }

        for (const file of files) objects.push(await blob.put(file.name, file, resolvedOptions.put))
      }
      catch (error) {
        throw createError({
          message: `Storage error: ${readBlobErrorMessage(error)}`,
          statusCode: readBlobStatusCode(error),
        })
      }

      return objects
    },
  } satisfies BlobStorage

  return blob
}
