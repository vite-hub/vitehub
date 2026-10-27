import { literal, object, parse, string } from "valibot"

import { toArray } from "@vite-hub/internal/arrays"
import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"
import { createH3V1ResponseHeaders, isH3V1Event, toH3V1Request } from "@vite-hub/internal/runtime/h3-v1-request"

import { blobError, blobResult } from "./errors.ts"
import { handleBlobMultipartUpload, handleBlobUpload, validateMultipartParts } from "./upload.ts"

// Generated provider runtime modules import the handlers from this entry.
export { handleBlobMultipartUpload, handleBlobUpload }
export { createLazyBlobMedia } from "./media/lazy.ts"

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobListOptions, BlobMultipartUpload, BlobPutBody, BlobPutOptions, BlobResult, BlobServeEvent, BlobServeResponseOptions, BlobStorage } from "./types.ts"
import type { BlobImagesOptions, BlobImageTransformer } from "./media/types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import isBlob from "./internal/is-blob.ts"
import { readDerivedHeader } from "./internal/derived-header.ts"
import { assertValidPathname } from "./internal/pathname.ts"
import { createBlobMedia } from "./media/records.ts"
import { resolveBlobImages } from "./media/transformers.ts"

// S3, R2, and Vercel Blob all accept part numbers 1 through 10000.
const maxPartNumber = 10_000

function normalizeServeEvent(event: Parameters<BlobStorage["serve"]>[0]): BlobServeEvent {
  if (!isH3V1Event(event)) return event
  // The accepted Node event type requires its writable response.
  const response = event.node.res!
  return {
    req: toH3V1Request(event),
    res: {
      headers: createH3V1ResponseHeaders(response),
      get status() { return response.statusCode },
      set status(value) { if (value !== undefined) response.statusCode = value },
    },
  }
}

function matchesETag(condition: string | null, etag: string | undefined): boolean {
  if (!condition) return false
  if (condition.trim() === "*") return true
  return Boolean(etag && condition.match(/(?:W\/)?"[^"]*"/g)?.some(tag => tag.replace(/^W\//, "") === etag.replace(/^W\//, "")))
}

/** Give a driver's multipart upload the `[error, value]` result contract. */
export function toBlobMultipartUpload(upload: BlobDriverMultipartUpload, store: string): BlobMultipartUpload {
  return {
    pathname: upload.pathname,
    uploadId: upload.uploadId,
    abort: () => blobResult("multipart", store, () => upload.abort()),
    complete: parts => {
      validateMultipartParts(parts)
      return blobResult("multipart", store, () => upload.complete(parts))
    },
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

// Decode the pathname once, then reject it before a driver, filesystem, or URL can resolve it elsewhere.
function normalizePathname(pathname: string, options?: { prefix?: boolean }): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    decoded = pathname
  }
  return assertValidPathname(decoded.replace(/^\/+/, ""), options)
}

// `_vitehub/derived/` holds cached variants and `_vitehub/media/` holds media records and crop replacements.
const reservedNamespaces = ["derived", "media"]

function resolvedParts(pathname: string): string[] {
  const parts: string[] = []
  for (const part of pathname.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  return parts
}

function isReservedPath(pathname: string): boolean {
  const parts = resolvedParts(pathname)
  return parts[0]?.toLowerCase() === "_vitehub" && (parts.length === 1 || reservedNamespaces.includes(parts[1]!.toLowerCase()))
}

function assertWritablePath(pathname: string) {
  if (isReservedPath(pathname)) {
    throw blobErrorDiagnostics.BLOB_R0033({ message: "Blob pathname uses a reserved ViteHub namespace: _vitehub/derived or _vitehub/media." })
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
  return `${vitehubOwnedPrefix}derived/${await hashCacheKey(pathname)}/`
}

async function readDerived(cache: Blob | null, fingerprint: string): Promise<Blob | null> {
  if (!cache) return null
  const header = await readDerivedHeader(cache)
  if (!header) return null
  try {
    const metadata = parse(object({ fingerprint: literal(fingerprint), type: string() }),
      JSON.parse(header.text))
    return cache.slice(header.bodyOffset, cache.size, metadata.type)
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
  // The prefix and the suffix can change the pathname, so check the final value.
  return assertValidPathname(options.prefix
    ? joinPath(options.prefix, normalized)
    : normalized)
}

/**
 * Reads one `Range: bytes=` spec. Returns `undefined` to send the whole body: no range, several ranges, a stale
 * `If-Range`, or a malformed header. Browsers need ranges to seek media, and Safari does not play video without them.
 */
function selectByteRange(event: BlobServeEvent, etag: string | undefined, size: number): { start: number, end: number } | "unsatisfiable" | undefined {
  // RFC 9110 section 14.2 requires ignoring Range on methods other than GET.
  if (event.req.method !== "GET") return
  const header = event.req.headers.get("range")
  if (!header) return
  const ifRange = event.req.headers.get("if-range")
  // Only a strong ETag can validate If-Range. Without a match, send the current whole body.
  if (ifRange !== null && (!etag || ifRange !== etag)) return
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return
  if (!match[1]) {
    const length = Number(match[2])
    return length > 0 && size > 0 ? { start: Math.max(0, size - length), end: size - 1 } : "unsatisfiable"
  }
  const start = Number(match[1])
  const end = match[2] ? Number(match[2]) : Infinity
  if (end < start) return
  return start < size ? { start, end: Math.min(end, size - 1) } : "unsatisfiable"
}

/** Options of `createBlobStorage()`. The runtime fills them from the `blob` configuration. */
export interface BlobStorageOptions {
  /** Image variants. A transformer object plugs in another image service. `false` always serves originals. */
  images?: BlobImagesOptions | BlobImageTransformer | false
  /** Served URL of a pathname, added to media records. */
  url?: (pathname: string) => string | undefined | Promise<string | undefined>
}

export function createBlobStorage(driver: BlobDriverAdapter<any>, store: string = driver.name, options: BlobStorageOptions = {}): BlobStorage {
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
  const media = createBlobMedia({
    clearDerived,
    derivedPrefix: derivedCachePrefix,
    driver,
    images: resolveBlobImages(options.images),
    // Media checks empty paths itself, so only reject unsafe segments here.
    normalizePathname: pathname => normalizePathname(pathname, { prefix: true }),
    // Media writes go through the public operations, so they share path checks and derived-cache cleanup.
    storage: {
      del: pathnames => storage.del(pathnames),
      list: listOptions => storage.list(listOptions),
      put: (pathname, body, putOptions) => storage.put(pathname, body, putOptions),
    },
    store,
    ...(options.url ? { url: options.url } : {}),
  })
  const storage: BlobStorage = {
    media,
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
      const normalizedPrefix = options.prefix ? normalizePathname(options.prefix, { prefix: true }) : options.prefix
      return blobResult("list", store, () => driver.list({
        ...options,
        prefix: normalizedPrefix,
      }))
    },
    async put(pathname: string, body: BlobPutBody, options: BlobPutOptions = {}) {
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), options)
      assertWritablePath(normalizedPath)
      const contentType = options.contentType || (isBlob(body) ? body.type : undefined) || guessContentType(normalizedPath)
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
    async serve(input, pathname: string, options = {}) {
      const event = normalizeServeEvent(input)
      const normalizedPath = normalizePathname(pathname)
      if (isReservedPath(normalizedPath)) return [blobError("BLOB_NOT_FOUND", "serve", store), undefined]
      if (options.variant && !options.transform) {
        const [error, plan] = await blobResult("serve", store, () => media.planVariant(normalizedPath, options.variant!))
        if (error) return [error, undefined]
        if (plan) return serveObject(event, plan.source, { ...options, transform: plan.transform })
      }
      return serveObject(event, normalizedPath, options)
    },
    store() {
      throw blobErrorDiagnostics.BLOB_R0026({ message: "Named Blob stores are only available from the @vite-hub/blob runtime export." })
    },
  }
  async function serveObject(event: BlobServeEvent, normalizedPath: string, options: BlobServeResponseOptions): Promise<BlobResult<ReadableStream | null>> {
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
          if (matchesETag(event.req.headers.get("if-none-match"), etag)) {
            for (const [name, value] of headers) event.res.headers.set(name, value)
            for (const name of ["content-length", "content-type", "content-encoding", "transfer-encoding"]) event.res.headers.delete(name)
            event.res.status = 304
            event.res.headers.set("X-Content-Type-Options", "nosniff")
            return null
          }
        }

        if (event.req.method === "HEAD" && !options.transform && meta.contentType
          && meta.size !== undefined && Number.isSafeInteger(meta.size) && meta.size >= 0) {
          headers.set("Accept-Ranges", "bytes")
          headers.set("Content-Length", String(meta.size))
          headers.set("Content-Type", meta.contentType)
          headers.set("X-Content-Type-Options", "nosniff")
          for (const [name, value] of headers) event.res.headers.set(name, value)
          return new Blob([]).stream()
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
                    JSON.stringify({ fingerprint: etag, key: transform.key, type: derived.type }), "\n", derived,
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
        if (!transform) {
          headers.set("Accept-Ranges", "bytes")
          const range = selectByteRange(event, etag, body.size)
          if (range === "unsatisfiable") {
            headers.set("Content-Range", `bytes */${body.size}`)
            body = new Blob([])
            event.res.status = 416
          }
          else if (range) {
            headers.set("Content-Range", `bytes ${range.start}-${range.end}/${body.size}`)
            body = body.slice(range.start, range.end + 1, body.type)
            event.res.status = 206
          }
        }
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
  }
  return storage
}
