import { createError, setHeader } from "h3"

import type { BlobDriverAdapter } from "./drivers/types.ts"
import type { BlobListOptions, BlobObject, BlobPutOptions, BlobStorage } from "./types.ts"

function normalizePathname(pathname: string): string {
  return decodeURIComponent(pathname).replace(/^\/+/, "")
}

function joinPath(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
}

function splitPath(pathname: string) {
  const cleanPath = normalizePathname(pathname)
  const segments = cleanPath.split("/").filter(Boolean)
  const filename = segments.pop() || ""
  const dotIndex = filename.lastIndexOf(".")

  return {
    dir: segments.join("/"),
    ext: dotIndex > 0 ? filename.slice(dotIndex) : "",
    name: dotIndex > 0 ? filename.slice(0, dotIndex) : filename,
  }
}

function guessContentType(pathname: string): string {
  const filename = normalizePathname(pathname).split("/").pop() || ""
  const dotIndex = filename.lastIndexOf(".")
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase() : ""
  const known: Record<string, string> = {
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
  }
  return known[extension] || "application/octet-stream"
}

function normalizeBlobPath(pathname: string, options: BlobPutOptions) {
  const { dir, ext, name } = splitPath(pathname)
  const filename = options.addRandomSuffix
    ? `${name}-${globalThis.crypto.randomUUID().split("-")[0]}${ext}`
    : `${name}${ext}`
  const normalized = joinPath(dir, filename)
  return options.prefix
    ? joinPath(options.prefix, normalized)
    : normalized
}

export function createBlobStorage(driver: BlobDriverAdapter<any>): BlobStorage {
  return {
    async delete(pathnames: string | string[]) {
      await this.del(pathnames)
    },
    async del(pathnames: string | string[]) {
      const values = Array.isArray(pathnames) ? pathnames : [pathnames]
      await driver.delete(values.map(value => normalizePathname(value)))
    },
    async get(pathname: string) {
      return driver.get(normalizePathname(pathname))
    },
    async head(pathname: string) {
      const meta = await driver.head(normalizePathname(pathname))
      if (!meta) {
        throw createError({ message: "Blob not found", statusCode: 404 })
      }
      return meta
    },
    async list(options: BlobListOptions = {}) {
      return driver.list({
        ...options,
        prefix: options.prefix ? normalizePathname(options.prefix) : options.prefix,
      })
    },
    async put(pathname: string, body: string | ReadableStream<unknown> | ArrayBuffer | ArrayBufferView | Blob, options: BlobPutOptions = {}) {
      const normalizedPath = normalizeBlobPath(pathname, options)
      const contentType = options.contentType || (body instanceof Blob ? body.type : undefined) || guessContentType(normalizedPath)
      return driver.put(normalizedPath, body, {
        ...options,
        contentType,
      })
    },
    async serve(event, pathname: string) {
      const normalizedPath = normalizePathname(pathname)
      const arrayBuffer = await driver.getArrayBuffer(normalizedPath)
      if (!arrayBuffer) {
        throw createError({ message: "File not found", statusCode: 404 })
      }

      const meta = await driver.head(normalizedPath)
      const contentType = meta?.contentType || guessContentType(normalizedPath)

      setHeader(event, "Content-Length", String(arrayBuffer.byteLength))
      setHeader(event, "Content-Type", contentType)
      if (meta?.httpEtag) {
        setHeader(event, "etag", meta.httpEtag)
      }

      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(arrayBuffer))
          controller.close()
        },
      })
    },
  }
}
