import { handleCacheHeaders, type H3Event } from "h3"
import { literal, object, parse, string } from "valibot"

import { toArray } from "@vite-hub/internal/arrays"

import { blobError, blobResult } from "./errors.ts"
import { handleBlobMultipartUpload, handleBlobUpload } from "./upload.ts"

// Generated provider runtime modules import the handlers from this entry.
export { handleBlobMultipartUpload, handleBlobUpload }

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobListOptions, BlobMultipartUpload, BlobPutBody, BlobPutOptions, BlobStorage } from "./types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"

// S3, R2, and Vercel Blob all accept part numbers 1 through 10000.
const maxPartNumber = 10_000

/** Give a driver's multipart upload the `[error, value]` result contract. */
export function toBlobMultipartUpload(upload: BlobDriverMultipartUpload, store: string): BlobMultipartUpload {
  return {
    pathname: upload.pathname,
    uploadId: upload.uploadId,
    abort: () => blobResult("multipart", store, () => upload.abort()),
    complete: parts => blobResult("multipart", store, () => upload.complete(parts)),
    uploadPart(partNumber, body) {
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxPartNumber) {
        throw blobErrorDiagnostics.BLOB_R0031({ message: `\`partNumber\` must be an integer from 1 to ${maxPartNumber}.` })
      }
      return blobResult("multipart", store, () => upload.uploadPart(partNumber, body))
    },
  }
}

function unsupportedMultipart(driver: BlobDriverAdapter<unknown>): Error {
  return blobErrorDiagnostics.BLOB_R0030({ message: `Blob driver "${driver.name}" does not support multipart uploads. Use the fs, cloudflare-r2, or vercel-blob driver.` })
}

function normalizePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, "")
  }
  catch {
    return pathname.replace(/^\/+/, "")
  }
}

function assertWritablePath(pathname: string) {
  const parts: string[] = []
  for (const part of pathname.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  if (parts[0]?.toLowerCase() === "_vitehub" && (parts.length === 1 || parts[1]?.toLowerCase() === "derived")) {
    throw blobErrorDiagnostics.BLOB_R0033({ message: "Blob pathname uses the reserved derived cache namespace." })
  }
}

async function hashCacheKey(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function hashBlob(body: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await body.arrayBuffer())
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function derivedCachePrefix(pathname: string): Promise<string> {
  return `_vitehub/derived/${await hashCacheKey(pathname)}/`
}

async function readDerived(cache: Blob | null, fingerprint: string): Promise<Blob | null> {
  if (!cache) return null
  const header = new Uint8Array(await cache.slice(0, 4096).arrayBuffer())
  const boundary = header.indexOf(10)
  if (boundary < 0) return null
  try {
    const metadata = parse(object({ fingerprint: literal(fingerprint), type: string() }),
      JSON.parse(new TextDecoder().decode(header.subarray(0, boundary))))
    return cache.slice(boundary + 1, cache.size, metadata.type)
  }
  catch {
    return null
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
  const pendingTransforms = new Map<string, Promise<Blob | undefined | false>>()
  async function clearDerived(pathname: string) {
    try {
      const prefix = await derivedCachePrefix(driver.canonicalPathname?.(pathname) ?? pathname)
      const paths: string[] = []
      let cursor: string | undefined
      do {
        const page = await driver.list({ prefix, cursor })
        paths.push(...page.blobs.map(object => object.pathname))
        cursor = page.hasMore ? page.cursor : undefined
      } while (cursor)
      if (paths.length) await driver.delete(paths)
    }
    catch (error) {
      console.error("[vitehub/blob] Derived cache cleanup failed", error)
    }
  }
  const storage: BlobStorage = {
    async createMultipartUpload(pathname, options = {}) {
      if (!driver.createMultipartUpload) throw unsupportedMultipart(driver)
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), options)
      assertWritablePath(normalizedPath)
      const contentType = options.contentType || guessContentType(normalizedPath)
      return blobResult("multipart", store, async () => toBlobMultipartUpload(
        await driver.createMultipartUpload!(normalizedPath, { ...options, contentType }),
        store,
      ))
    },
    handleMultipartUpload: (event, options) => handleBlobMultipartUpload(storage, event, options),
    handleUpload: (event, options) => handleBlobUpload(storage, event, options),
    async resumeMultipartUpload(pathname, uploadId) {
      if (!driver.resumeMultipartUpload) throw unsupportedMultipart(driver)
      const normalizedPath = normalizePathname(pathname)
      assertWritablePath(normalizedPath)
      return blobResult("multipart", store, async () => toBlobMultipartUpload(
        await driver.resumeMultipartUpload!(normalizedPath, uploadId),
        store,
      ))
    },
    async del(pathnames: string | string[]) {
      const normalizedPathnames = toArray(pathnames).map(value => normalizePathname(value))
      return blobResult("del", store, async () => {
        await driver.delete(normalizedPathnames)
        await Promise.all(normalizedPathnames.map(clearDerived))
      })
    },
    async get(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      return blobResult("get", store, () => driver.get(normalizedPathname))
    },
    async head(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      return blobResult("head", store, () => driver.head(normalizedPathname))
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
      assertWritablePath(normalizedPath)
      const contentType = options.contentType || (body instanceof Blob ? body.type : undefined) || guessContentType(normalizedPath)
      return blobResult("put", store, () => driver.put(normalizedPath, body, {
        ...options,
        contentType,
      }))
    },
    async sign(pathname, options) {
      if (!Number.isInteger(options.expiresIn) || options.expiresIn <= 0) {
        throw blobErrorDiagnostics.BLOB_R0024({ message: "`expiresIn` must be a positive integer." })
      }
      if (!driver.sign) {
        throw blobErrorDiagnostics.BLOB_R0025({ message: `Blob driver "${driver.name}" does not support signed requests.` })
      }
      const normalizedPathname = normalizePathname(pathname)
      if (options.method === "PUT") assertWritablePath(normalizedPathname)
      return blobResult("sign", store, () => driver.sign!(normalizedPathname, options))
    },
    async serve(event, pathname: string, options = {}) {
      const normalizedPath = normalizePathname(pathname)
      for (let attempt = 0; attempt < 3; attempt++) {
        const [error, payload] = await blobResult("serve", store, async () => {
          const meta = await driver.head(normalizedPath)
          if (!meta) {
            await clearDerived(normalizedPath)
            return
          }

          let etag = meta.httpEtag ? `"${await hashCacheKey([meta.httpEtag, meta.contentType])}"` : undefined
          let sourceVersion = meta.httpEtag
          let cachePath: string | undefined
          let originalBody: Blob | null | undefined
          if (options.transform) {
            const sourcePath = driver.canonicalPathname?.(normalizedPath) ?? normalizedPath
            if (!sourceVersion) {
              originalBody = await driver.get(normalizedPath)
              if (!originalBody) return
              sourceVersion = await hashBlob(originalBody)
            }
            const fingerprint = await hashCacheKey([
              sourcePath, sourceVersion, meta.contentType, options.transform.key,
            ])
            etag = `"${fingerprint}"`
            cachePath = `${await derivedCachePrefix(sourcePath)}${await hashCacheKey(options.transform.key)}`
          }

          const cacheControl = options.cacheControl ?? event.res.headers.get("Cache-Control") ?? "private, no-cache"
          const headers = new Headers({ "Cache-Control": cacheControl })
          if (etag) headers.set("ETag", etag)
          if (["GET", "HEAD"].includes(event.req.method)) {
            const previous = ["etag", "cache-control"].map(name => [name, event.res.headers.get(name)] as const)
            // SAFETY: h3 reads only the native request headers and mutable response headers/status declared by BlobServeEvent.
            if (handleCacheHeaders(event as H3Event, { etag, cacheControls: [cacheControl] })) {
              event.res.headers.set("X-Content-Type-Options", "nosniff")
              return null
            }
            // h3 writes success headers while checking validators. Restore them before fallible work.
            for (const [name, value] of previous) {
              if (value === null) event.res.headers.delete(name)
              else event.res.headers.set(name, value)
            }
          }

          const cached = cachePath
            ? await driver.get(cachePath).catch((error) => {
              console.error("[vitehub/blob] Transform cache read failed", error)
              return null
            })
            : null
          let body = cachePath
            ? await readDerived(cached, etag!)
            : await driver.get(normalizedPath)
          const transform = options.transform
          if (body && !transform) {
            const snapshot = await driver.head(normalizedPath)
            if (!snapshot) return
            if (snapshot.httpEtag !== meta.httpEtag || snapshot.contentType !== meta.contentType) return false
          }
          if (!body && cachePath && transform) {
            const key = cachePath
            const pendingKey = `${key}:${etag}`
            let pending = pendingTransforms.get(pendingKey)
            if (!pending) {
              pending = (async () => {
                const original = originalBody ?? await driver.get(normalizedPath)
                if (!original) return
                const snapshot = await driver.head(normalizedPath)
                if (!snapshot) return
                if (snapshot.httpEtag !== meta.httpEtag || snapshot.contentType !== meta.contentType) return false as const
                const derived = await transform.run(original)
                const current = await driver.head(normalizedPath)
                const currentBody = current && !meta.httpEtag ? await driver.get(normalizedPath) : null
                const sameVersion = meta.httpEtag
                  ? current?.httpEtag === meta.httpEtag
                  : currentBody && await hashBlob(currentBody) === sourceVersion
                if (current && current.contentType === meta.contentType && sameVersion) {
                  try {
                    // Replace stale entries even when a provider forbids overwriting objects.
                    if (cached) await driver.delete([key])
                    // Keep the version and body in one object. Some drivers reject custom metadata.
                    await driver.put(key, new Blob([
                      JSON.stringify({ fingerprint: etag, type: derived.type }), "\n", derived,
                    ]), {
                      contentType: "application/octet-stream",
                    })
                    if (!await driver.head(normalizedPath)) await driver.delete([key])
                  }
                  catch (error) {
                    console.error("[vitehub/blob] Transform cache write failed", error)
                  }
                }
                return derived
              })().finally(() => pendingTransforms.delete(pendingKey))
              pendingTransforms.set(pendingKey, pending)
            }
            const transformed = await pending
            if (transformed === false) return false
            body = transformed ?? null
          }
          if (!body) return
          const stream = body.stream()
          headers.set("X-Content-Type-Options", "nosniff")
          headers.set("Content-Length", String(body.size))
          headers.set("Content-Type", transform
            ? body.type || "application/octet-stream"
            : meta.contentType || body.type || guessContentType(normalizedPath))
          for (const [name, value] of headers) event.res.headers.set(name, value)
          return stream
        })
        if (error) return [error, undefined]
        if (payload === false) continue
        return payload === undefined
          ? [blobError("BLOB_NOT_FOUND", "serve", store), undefined]
          : [null, payload]
      }
      return blobResult("serve", store, async () => {
        throw new Error("Blob changed repeatedly while preparing its response.")
      })
    },
    store() {
      throw blobErrorDiagnostics.BLOB_R0026({ message: "Named Blob stores are only available from the @vite-hub/blob runtime export." })
    },
  }
  return storage
}
