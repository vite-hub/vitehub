import { setHeader } from "h3"

import { toArray } from "@vite-hub/internal/arrays"

import { blobError, blobResult } from "./errors.ts"

import type { BlobDriverAdapter, BlobListOptions, BlobPutBody, BlobPutOptions, BlobServeEvent, BlobStorage } from "./types.ts"

function setBlobResponseHeader(event: BlobServeEvent, name: string, value: string) {
  // SAFETY: BlobServeEvent exposes the response headers setHeader mutates and omits only unrelated H3 event fields.
  setHeader(event as Parameters<typeof setHeader>[0], name, value)
}

function normalizePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, "")
  }
  catch {
    return pathname.replace(/^\/+/, "")
  }
}

function joinPath(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part && part.length > 0))
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
}

// Expects pathname already normalized via normalizePathname.
function splitPath(pathname: string) {
  const segments = pathname.split("/").filter(Boolean)
  const filename = segments.pop() || ""
  const dotIndex = filename.lastIndexOf(".")

  return {
    dir: segments.join("/"),
    ext: dotIndex > 0 ? filename.slice(dotIndex) : "",
    name: dotIndex > 0 ? filename.slice(0, dotIndex) : filename,
  }
}

// Expects pathname already normalized via normalizePathname.
function guessContentType(pathname: string): string {
  const filename = pathname.split("/").pop() || ""
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

export function createBlobStorage(driver: BlobDriverAdapter<any>, store: string = driver.name): BlobStorage {
  return {
    async del(pathnames: string | string[]) {
      const normalizedPathnames = toArray(pathnames).map(value => normalizePathname(value))
      return blobResult("del", store, async () => {
        await driver.delete(normalizedPathnames)
      })
    },
    async get(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      return blobResult("get", store, () => driver.get(normalizedPathname))
    },
    async head(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      const [error, meta] = await blobResult("head", store, () => driver.head(normalizedPathname))
      if (error) return [error, undefined]
      return meta
        ? [null, meta]
        : [blobError("BLOB_NOT_FOUND", "head", store), undefined]
    },
    async list(options: BlobListOptions = {}) {
      const normalizedPrefix = options.prefix ? normalizePathname(options.prefix) : options.prefix
      return blobResult("list", store, () => driver.list({
        ...options,
        prefix: normalizedPrefix,
      }))
    },
    async put(pathname: string, body: BlobPutBody, options: BlobPutOptions = {}) {
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), options)
      const contentType = options.contentType || (body instanceof Blob ? body.type : undefined) || guessContentType(normalizedPath)
      return blobResult("put", store, () => driver.put(normalizedPath, body, {
        ...options,
        contentType,
      }))
    },
    async sign(pathname, options) {
      if (!Number.isInteger(options.expiresIn) || options.expiresIn <= 0) {
        throw new TypeError("`expiresIn` must be a positive integer.")
      }
      if (!driver.sign) {
        throw new Error(`Blob driver "${driver.name}" does not support signed requests.`)
      }
      const normalizedPathname = normalizePathname(pathname)
      return blobResult("sign", store, () => driver.sign!(normalizedPathname, options))
    },
    async serve(event, pathname: string) {
      const normalizedPath = normalizePathname(pathname)
      const [error, payload] = await blobResult("serve", store, async () => {
        const arrayBuffer = await driver.getArrayBuffer(normalizedPath)
        if (!arrayBuffer) return

        const meta = await driver.head(normalizedPath)
        const contentType = meta?.contentType || guessContentType(normalizedPath)

        setBlobResponseHeader(event, "Content-Length", String(arrayBuffer.byteLength))
        setBlobResponseHeader(event, "Content-Type", contentType)
        if (meta?.httpEtag) {
          setBlobResponseHeader(event, "etag", meta.httpEtag)
        }

        return new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(arrayBuffer))
            controller.close()
          },
        })
      })
      if (error) return [error, undefined]
      return payload
        ? [null, payload]
        : [blobError("BLOB_NOT_FOUND", "serve", store), undefined]
    },
    store() {
      throw new Error("Named Blob stores are only available from the @vite-hub/blob runtime export.")
    },
  }
}
