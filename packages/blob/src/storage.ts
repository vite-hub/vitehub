import { literal, object, parse, string } from "valibot"

import { toArray } from "@vite-hub/internal/arrays"
import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"
import { logFailure } from "@vite-hub/internal/runtime/request-log"

import { blobError, blobHttpError, blobResult } from "./errors.ts"
import { createUploadHandler, handleBlobMultipartUpload, handleBlobUpload, validateMultipartParts } from "./upload.ts"

// Generated provider runtime modules import the handlers from this entry.
export { handleBlobMultipartUpload, handleBlobUpload }
export { createLazyBlobMedia } from "./media/lazy.ts"
export { blobStoreMode, readonlyBlobStorage } from "./readonly.ts"

import { parseDuration } from "@vite-hub/runtime"
import type { Result } from "@vite-hub/runtime"

import type { BlobDeletePrefixOptions, BlobDeletePrefixResult, BlobDriverAdapter, BlobDriverMultipartUpload, BlobDriverPutCondition, BlobErrorCode, BlobListOptions, BlobMultipartUpload, BlobObject, BlobServeResponseOptions, BlobStorage } from "./types.ts"
import type { BlobImagesOptions, BlobImageTransformer } from "./media/types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { downloadDisposition, isActiveContentType } from "./internal/active-content.ts"
import { matchesETag, parseByteRange, selectByteRange } from "./internal/serve-request.ts"
import { edgeCacheKey, keepInEdgeCache, matchEdgeCache } from "./internal/edge-cache.ts"
import isBlob from "./internal/is-blob.ts"
import { readDerivedHeader } from "./internal/derived-header.ts"
import { withHostPathnameLimits } from "./internal/host-limits.ts"
import { assertValidPathname, decodePathname, normalizeBlobPath, pathnameIssue } from "./internal/pathname.ts"
import { blobSizeToBytes } from "./internal/size.ts"
import { createBlobMedia } from "./media/records.ts"
import { resolveBlobImages } from "./media/transformers.ts"

// S3, R2, and Vercel Blob all accept part numbers 1 through 10000.
const maxPartNumber = 10_000

const blobStorageHealthChecks = new WeakMap<BlobStorage, () => Promise<void>>()

export function registerBlobStorageHealthCheck(storage: BlobStorage, check: () => Promise<void>): void {
  blobStorageHealthChecks.set(storage, check)
}

export async function checkBlobStorageHealth(storage: BlobStorage): Promise<void> {
  const check = blobStorageHealthChecks.get(storage)
  if (check) return check()
  const [error] = await storage.head("vitehub-health-check")
  if (error) throw error
}

export async function checkBlobDriverHealth(driver: BlobDriverAdapter<unknown>): Promise<void> {
  if (driver.checkHealth) await driver.checkHealth()
  else if (driver.name === "s3") await driver.list({ limit: 1 })
  else await driver.head("vitehub-health-check")
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
  return blobErrorDiagnostics.BLOB_R0030({ message: `Blob driver "${driver.name}" does not support multipart uploads. Use the fs, cloudflare, or vercel driver.` })
}


// Reject the decoded pathname before a driver, filesystem, or URL can resolve it elsewhere.
function normalizePathname(pathname: string, options?: { prefix?: boolean }): string {
  return assertValidPathname(decodePathname(pathname), options)
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

// The fs driver keeps metadata, hashes, and multipart parts under `.vitehub/`. Every driver reserves it, so a store
// behaves the same on every host.
function isReservedPath(pathname: string): boolean {
  const [first, second] = resolvedParts(pathname).map(part => part.toLowerCase())
  if (first === ".vitehub") return true
  return first === "_vitehub" && (second === undefined || reservedNamespaces.includes(second))
}

// No object lives under `.vitehub/`: writes there fail on every driver. `_vitehub/media/` holds crop replacements that
// an app reads, so it is not in this check.
function isInternalPath(pathname: string): boolean {
  return resolvedParts(pathname)[0]?.toLowerCase() === ".vitehub"
}

function assertWritablePath(pathname: string) {
  if (isReservedPath(pathname)) {
    // An H3 `HTTPError`, so a route that writes a client pathname answers 403, like the Blob operations.
    throw blobHttpError(403, blobErrorDiagnostics.BLOB_R0033({ message: "Blob pathname uses a reserved ViteHub namespace: .vitehub, _vitehub/derived, or _vitehub/media." }))
  }
}

// `access` was a put() option that only Vercel Blob read. Other drivers dropped it and served the object anyway.
function assertNoPutAccess(options: object) {
  if (Object.hasOwn(options, "access")) {
    throw blobErrorDiagnostics.BLOB_R0045({ message: "`access` is not a Blob put() option. One object cannot be private on its own: the store and `blob.serve` decide who may read it." })
  }
}

/**
 * An error response keeps the CORS headers of the `headers` option, so a page on another origin can read its status.
 * The other headers describe the object, such as `Cache-Control`, and stay off.
 */
function blobErrorResponse(request: Request, options: BlobServeResponseOptions, status: 400 | 404 | 405, error: string, allow?: string): Response {
  const headers = new Headers()
  for (const [name, value] of new Headers(options.headers)) {
    if (name.startsWith("access-control-")) headers.set(name, value)
  }
  if (allow) headers.set("Allow", allow)
  const response = Response.json({ error }, { headers, status })
  return request.method === "HEAD" ? new Response(null, { headers: response.headers, status }) : response
}

async function hashCacheKey(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
}

async function hashBlob(body: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await body.arrayBuffer())
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
}

// One driver call deletes at most this many objects, so a large prefix does not open thousands of requests at once.
const deleteBatchSize = 100

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

// Expects pathname already normalized via normalizePathname.
function guessContentType(pathname: string): string {
  const filename = pathname.split("/").pop() || ""
  const dotIndex = filename.lastIndexOf(".")
  const extension = dotIndex > 0 ? filename.slice(dotIndex).toLowerCase() : ""
  const known: Record<string, string> = {
    ".avif": "image/avif",
    ".css": "text/css; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
    ".wav": "audio/wav",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  }
  return known[extension] || "application/octet-stream"
}

function notModified(headers: Headers): Response {
  for (const name of ["content-length", "content-type", "content-encoding", "transfer-encoding"]) headers.delete(name)
  headers.set("X-Content-Type-Options", "nosniff")
  return new Response(null, { headers, status: 304 })
}

/** Options of `createBlobStorage()`. The runtime fills them from the `blob` configuration. */
export interface BlobStorageOptions {
  /** Image variants. A transformer object plugs in another image service. `false` always serves originals. */
  images?: BlobImagesOptions | BlobImageTransformer | false
  /** Served URL of a pathname, added to media records. */
  url?: (pathname: string) => string | undefined | Promise<string | undefined>
}

/** Only `vite dev` sets `remote: true` on a store, so the dev server warns once per store that writes change real data. */
function warnRemoteStore(options: { bucketName?: unknown, driver?: unknown, remote?: unknown } | undefined, store: string): void {
  if (options?.remote !== true) return
  const bucket = typeof options.bucketName === "string" && options.bucketName ? ` ${options.bucketName}` : ""
  const target = options.driver === "vercel"
    ? "Vercel Blob store"
    : options.driver === "cloudflare" ? `R2 bucket${bucket}` : `\`${String(options.driver)}\` store`
  console.warn(`[vitehub] Blob store "${store}" is remote: \`vite dev\` uses the real ${target}. Writes change real data.`)
}

export function createBlobStorage(hostDriver: BlobDriverAdapter<any>, store: string = hostDriver.name, options: BlobStorageOptions = {}): BlobStorage {
  warnRemoteStore(hostDriver.options, store)
  const driver = withHostPathnameLimits(hostDriver)
  const pendingTransforms = new Map<string, Promise<Blob | undefined | false>>()
  /**
   * Logs a cache failure that the operation survives. `request` is the request that waits for the operation. Blob
   * operations get no `waitUntil()`, so an event of its own drains on its own.
   */
  function logCacheFailure(op: string, message: string, error: unknown, fallback: () => void, request?: Request) {
    logFailure({ field: "blob", fields: { op, store, driver: hostDriver.name }, message, error, ...(request ? { request } : {}) }, fallback)
  }
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
      logCacheFailure("derived-cache-cleanup", "Blob derived cache cleanup failed", error, () => console.error("[vitehub/blob] Derived cache cleanup failed", error))
    }
  }
  // Lists every object first, then deletes, so a provider cursor never skips keys that a delete moved.
  async function deletePrefix(options: BlobDeletePrefixOptions): Promise<Result<BlobDeletePrefixResult, BlobErrorCode>> {
    // Check after decoding, so `/` or `%2F` cannot become the empty prefix that matches the whole store.
    const normalizedPrefix = typeof options.prefix === "string" ? normalizePathname(options.prefix, { prefix: true }) : ""
    if (!normalizedPrefix) {
      throw blobHttpError(400, blobErrorDiagnostics.BLOB_R0034({ message: "Blob delete({ prefix }) needs a non-empty prefix. Use list() and delete() to empty a whole store." }))
    }
    // `_vitehub` alone is reserved as a pathname, but as a prefix it also matches app objects such as `_vitehub-notes.txt`.
    const reservedPrefix = resolvedParts(normalizedPrefix).length > 1 && isReservedPath(normalizedPrefix)
    return blobResult("delete", store, async () => {
      const paths: string[] = []
      let cursor: string | undefined
      do {
        const page = await driver.list({ prefix: normalizedPrefix, cursor })
        for (const object of page.blobs) {
          if (isInternalPath(object.pathname) || (!reservedPrefix && isReservedPath(object.pathname))) continue
          paths.push(object.pathname)
        }
        cursor = page.hasMore ? page.cursor : undefined
      } while (cursor)
      for (let index = 0; index < paths.length; index += deleteBatchSize) {
        const batch = paths.slice(index, index + deleteBatchSize)
        await driver.delete(batch)
        await Promise.all(batch.map(clearDerived))
      }
      return { deleted: paths.length }
    })
  }
  function deleteObjects(pathnames: string | string[]): Promise<Result<void, BlobErrorCode>>
  function deleteObjects(options: BlobDeletePrefixOptions): Promise<Result<BlobDeletePrefixResult, BlobErrorCode>>
  async function deleteObjects(target: string | string[] | BlobDeletePrefixOptions): Promise<Result<void | BlobDeletePrefixResult, BlobErrorCode>> {
    if (typeof target === "object" && !Array.isArray(target)) return deletePrefix(target)
    const normalizedPathnames = toArray(target).map(value => normalizePathname(value))
    return blobResult("delete", store, async () => {
      await driver.delete(normalizedPathnames)
      await Promise.all(normalizedPathnames.map(clearDerived))
    })
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
      copy: (from, to, copyOptions) => storage.copy(from, to, copyOptions),
      delete: deleteObjects,
      list: listOptions => storage.list(listOptions),
      put: (pathname, body, putOptions) => storage.put(pathname, body, putOptions),
    },
    store,
    ...(options.url ? { url: options.url } : {}),
  })
  // A driver without a provider copy: read the object, then write it with its content type and custom metadata.
  async function copyByReading(from: string, to: string) {
    const object = await driver.head(from)
    const body = object && await driver.get(from)
    if (!object || !body) return null
    const customMetadata = Object.keys(object.customMetadata).length ? { customMetadata: object.customMetadata } : {}
    return driver.put(to, body, { ...(object.contentType ? { contentType: object.contentType } : {}), ...customMetadata })
  }
  const storage: BlobStorage = {
    media,
    async copy(from, to, options = {}) {
      const source = normalizePathname(from)
      // The destination follows the rules of put().
      const target = normalizeBlobPath(normalizePathname(to), {})
      assertWritablePath(target)
      const [error, copied] = await blobResult("copy", store, async (): Promise<BlobObject | "conflict" | null> => {
        const canonical = (pathname: string) => driver.canonicalPathname?.(pathname) ?? pathname
        if (canonical(source) === canonical(target)) return driver.head(source)
        if (!options.overwrite && await driver.head(target)) return "conflict"
        return driver.copy ? driver.copy(source, target) : copyByReading(source, target)
      })
      if (error) return [error, undefined]
      if (copied === "conflict") {
        return [blobError("BLOB_CONFLICT", "copy", store, { detail: `Blob ${target} already exists in the "${store}" store. Pass { overwrite: true } to replace it.` }), undefined]
      }
      if (!copied) return [blobError("BLOB_NOT_FOUND", "copy", store, { detail: `Blob ${source} was not found in the "${store}" store.` }), undefined]
      return [undefined, copied]
    },
    async createMultipartUpload(pathname, options = {}) {
      if (!driver.createMultipartUpload) throw unsupportedMultipart(driver)
      assertNoPutAccess(options)
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), options)
      assertWritablePath(normalizedPath)
      const contentType = options.contentType || guessContentType(normalizedPath)
      return blobResult("multipart", store, async () => toBlobMultipartUpload(
        await driver.createMultipartUpload!(normalizedPath, { ...options, contentType }),
        store,
      ))
    },
    handleMultipartUpload: (event, options) => handleBlobMultipartUpload(storage, event, options),
    handleUpload: createUploadHandler(() => storage, store),
    async resumeMultipartUpload(pathname, uploadId) {
      if (!driver.resumeMultipartUpload) throw unsupportedMultipart(driver)
      const normalizedPath = normalizePathname(pathname)
      assertWritablePath(normalizedPath)
      return blobResult("multipart", store, async () => toBlobMultipartUpload(
        await driver.resumeMultipartUpload!(normalizedPath, uploadId),
        store,
      ))
    },
    delete: deleteObjects,
    // A `.vitehub/` pathname reads as a missing object, as in `serve()`, on every driver.
    async get(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      if (isInternalPath(normalizedPathname)) return [undefined, null]
      return blobResult("get", store, () => driver.get(normalizedPathname))
    },
    async head(pathname: string) {
      const normalizedPathname = normalizePathname(pathname)
      if (isInternalPath(normalizedPathname)) return [undefined, null]
      return blobResult("head", store, () => driver.head(normalizedPathname))
    },
    async list(options: BlobListOptions = {}) {
      const normalizedPrefix = options.prefix ? normalizePathname(options.prefix, { prefix: true }) : options.prefix
      return blobResult("list", store, () => driver.list({
        ...options,
        prefix: normalizedPrefix,
      }))
    },
    async put(pathname, body, options = {}) {
      assertNoPutAccess(options)
      const { ifMatch, overwrite, ...putOptions } = options
      const condition: BlobDriverPutCondition | undefined = overwrite === false
        ? { type: "create" }
        : ifMatch === undefined ? undefined : { etag: ifMatch, type: "replace" }
      if (condition && !driver.putIf) throw blobErrorDiagnostics.BLOB_PUT_CONDITION_UNSUPPORTED({ driver: driver.name })
      const normalizedPath = normalizeBlobPath(normalizePathname(pathname), putOptions)
      assertWritablePath(normalizedPath)
      const contentType = putOptions.contentType || (isBlob(body) ? body.type : undefined) || guessContentType(normalizedPath)
      const [error, object] = await blobResult("put", store, async () => condition
        ? driver.putIf!(normalizedPath, body, { ...putOptions, contentType }, condition)
        : driver.put(normalizedPath, body, { ...putOptions, contentType }))
      // A driver that finds at write time that it cannot check the condition throws, like the check above.
      if (blobErrorDiagnostics.BLOB_PUT_CONDITION_UNSUPPORTED.is(error?.cause)) throw error.cause
      if (error) return [error, undefined]
      if (!object) {
        return [blobError("BLOB_CONFLICT", "put", store, {
          detail: condition?.type === "create"
            ? `Blob ${normalizedPath} already exists in the "${store}" store, and the put() had \`overwrite: false\`.`
            : `Blob ${normalizedPath} in the "${store}" store does not have the \`ifMatch\` ETag of the put(). Another writer changed or deleted it.`,
        }), undefined]
      }
      return [undefined, object]
    },
    async sign(pathname, options) {
      const expiresIn = typeof options.expiresIn === "string" ? parseDuration(options.expiresIn) / 1000 : options.expiresIn
      if (!Number.isInteger(expiresIn) || expiresIn <= 0) {
        throw blobErrorDiagnostics.BLOB_R0024({ message: "`expiresIn` must be a positive whole number of seconds or a duration such as \"15m\"." })
      }
      if (options.method === "PUT" && options.maxSize !== undefined && blobSizeToBytes(options.maxSize) === undefined) {
        throw blobErrorDiagnostics.BLOB_R0039({ message: `\`maxSize\` must be a size such as "8MB". Received ${JSON.stringify(options.maxSize)}.` })
      }
      if (options.method === "PUT" && options.contentLength !== undefined && !(Number.isSafeInteger(options.contentLength) && options.contentLength >= 0)) {
        throw blobErrorDiagnostics.BLOB_SIGN_CONTENT_LENGTH_INVALID()
      }
      if (!driver.sign) {
        throw blobErrorDiagnostics.BLOB_R0025({ message: `Blob driver "${driver.name}" does not support signed requests.` })
      }
      const normalizedPathname = normalizePathname(pathname)
      if (options.method === "PUT") assertWritablePath(normalizedPathname)
      return blobResult("sign", store, () => driver.sign!(normalizedPathname, { ...options, expiresIn }, { store }))
    },
    async serve(request, pathname, options = {}) {
      // Like a static file server, answer every other method without reading storage, so a POST to a file URL does
      // not download the file.
      if (request.method !== "GET" && request.method !== "HEAD") {
        return blobErrorResponse(request, options, 405, `Blob serve() answers GET and HEAD, not ${request.method}.`, "GET, HEAD")
      }
      const { edgeCache } = options
      if (edgeCache && (!Number.isSafeInteger(edgeCache.maxAge) || edgeCache.maxAge <= 0)) {
        throw blobErrorDiagnostics.BLOB_R0047({ message: "`edgeCache.maxAge` must be a positive integer." })
      }
      const decodedPath = decodePathname(pathname)
      const issue = pathnameIssue(decodedPath)
      if (issue) return blobErrorResponse(request, options, 400, `Invalid Blob pathname: it ${issue}.`)
      if (isReservedPath(decodedPath)) return blobErrorResponse(request, options, 404, "Blob not found.")
      const edge = edgeCache && !options.variant && !options.transform
        ? { key: edgeCacheKey(request, store, driver.canonicalPathname?.(decodedPath) ?? decodedPath), maxAge: edgeCache.maxAge }
        : undefined
      const kept = edge && await matchEdgeCache(request, edge.key)
      if (kept) return keptResponse(kept, options, decodedPath)
      const [error, response] = await serveRequest(request, decodedPath, options)
      if (!error) return edge ? keepInEdgeCache(request, edge.key, response, edge.maxAge) : response
      if (error.code === "BLOB_NOT_FOUND") return blobErrorResponse(request, options, 404, "Blob not found.")
      if (error.code === "BLOB_PATHNAME_TOO_LONG") return blobErrorResponse(request, options, 400, error.message)
      throw error
    },
    store() {
      throw blobErrorDiagnostics.BLOB_R0026({ message: "Named Blob stores are only available from the @vite-hub/blob runtime export." })
    },
  }
  // Expects a pathname that `serve()` decoded and checked.
  async function serveRequest(request: Request, normalizedPath: string, options: BlobServeResponseOptions): Promise<Result<Response, BlobErrorCode>> {
    if (options.variant && !options.transform) {
      const [error, plan] = await blobResult("serve", store, () => media.planVariant(normalizedPath, options.variant!))
      if (error) return [error, undefined]
      if (plan) return serveObject(request, plan.source, { ...options, transform: plan.transform })
    }
    return serveObject(request, normalizedPath, options)
  }
  // Starts from the `headers` option, so the headers that `serve()` sets replace it.
  function responseHeaders(options: BlobServeResponseOptions, normalizedPath: string): Headers {
    const headers = new Headers(options.headers)
    headers.set("Cache-Control", options.cacheControl ?? headers.get("Cache-Control") ?? "private, no-cache")
    const disposition = downloadDisposition(normalizedPath, options.download)
    if (disposition) headers.set("Content-Disposition", disposition)
    return headers
  }
  // The cache lookup applied Blob's range and `If-None-Match` rules using object metadata. Other headers come from this
  // request's options, like a response that reads storage.
  function keptResponse(kept: Response, options: BlobServeResponseOptions, normalizedPath: string): Response {
    const headers = responseHeaders(options, normalizedPath)
    const etag = kept.headers.get("etag")
    if (etag) headers.set("ETag", etag)
    const contentType = kept.headers.get("content-type") ?? undefined
    sandboxActiveContent(headers, options, contentType)
    if (kept.status === 304) return notModified(headers)
    for (const name of ["content-length", "content-range"]) {
      const value = kept.headers.get(name)
      if (value !== null) headers.set(name, value)
    }
    headers.set("Accept-Ranges", "bytes")
    if (contentType) headers.set("Content-Type", contentType)
    headers.set("X-Content-Type-Options", "nosniff")
    return new Response(kept.body, { headers, status: kept.status })
  }
  // A stored file can have any type that the uploader sent. Serve a type that a browser opens as a page in a CSP
  // sandbox, so it cannot run script on the app origin. The sandbox is added to a policy from the `headers` option.
  // Without a type, for example before a transform runs, the response always gets the sandbox.
  function sandboxActiveContent(headers: Headers, options: BlobServeResponseOptions, contentType?: string) {
    if (contentType !== undefined && !isActiveContentType(contentType)) return
    const policy = new Headers(options.headers).get("Content-Security-Policy")
    headers.set("Content-Security-Policy", policy ? `${policy}, sandbox` : "sandbox")
  }
  async function serveObject(request: Request, normalizedPath: string, options: BlobServeResponseOptions): Promise<Result<Response, BlobErrorCode>> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [error, payload] = await blobResult("serve", store, async () => {
        // A driver that streams reads the object, or the requested range of it, with its metadata in one call, and
        // without holding it in memory. A video and every seek in it cost one read and only the bytes sent.
        if (!options.transform && driver.getStream && request.method === "GET") {
          const requested = parseByteRange(request.headers.get("range"))
          let read = await driver.getStream(normalizedPath, { range: requested })
          if (read === false) return false
          if (!read) {
            await clearDerived(normalizedPath)
            return
          }
          const { object } = read
          const contentType = object.contentType || guessContentType(normalizedPath)
          const etag = object.httpEtag ? `"${await hashCacheKey([object.httpEtag, object.contentType])}"` : undefined
          const headers = responseHeaders(options, normalizedPath)
          if (etag) headers.set("ETag", etag)
          // A 304 updates the headers that a cache stored, so it carries the sandbox too.
          sandboxActiveContent(headers, options, contentType)
          if (matchesETag(request.headers.get("if-none-match"), etag)) {
            await read.body.cancel()
            return notModified(headers)
          }
          const range = selectByteRange(request, etag, object.size)
          if (requested && !range) {
            // A stale If-Range: send the whole body of the version just read.
            await read.body.cancel()
            read = await driver.getStream(normalizedPath, { etag: object.httpEtag })
            if (read === false) return false
            if (!read) return
            if (read.object.httpEtag !== object.httpEtag || read.object.contentType !== object.contentType) {
              await read.body.cancel()
              return false
            }
          }
          headers.set("Accept-Ranges", "bytes")
          headers.set("Content-Type", contentType)
          headers.set("X-Content-Type-Options", "nosniff")
          if (range === "unsatisfiable") {
            await read.body.cancel()
            headers.set("Content-Range", `bytes */${object.size}`)
            headers.set("Content-Length", "0")
            return new Response(null, { headers, status: 416 })
          }
          if (range) {
            headers.set("Content-Range", `bytes ${range.start}-${range.end}/${object.size}`)
            headers.set("Content-Length", String(range.end - range.start + 1))
            return new Response(read.body, { headers, status: 206 })
          }
          headers.set("Content-Length", String(object.size))
          return new Response(read.body, { headers })
        }

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

        const headers = responseHeaders(options, normalizedPath)
        if (etag) headers.set("ETag", etag)
        if (!options.transform) sandboxActiveContent(headers, options, meta.contentType || guessContentType(normalizedPath))
        if (["GET", "HEAD"].includes(request.method) && matchesETag(request.headers.get("if-none-match"), etag)) {
          // A 304 replaces the headers that a cache stored. The transform result type is not known here, so a 304 for a
          // transform always carries the sandbox. The sandbox does not change how an `<img>` shows an image.
          if (options.transform) sandboxActiveContent(headers, options)
          return notModified(headers)
        }

        if (request.method === "HEAD" && !options.transform && meta.contentType
          && meta.size !== undefined && Number.isSafeInteger(meta.size) && meta.size >= 0) {
          headers.set("Accept-Ranges", "bytes")
          headers.set("Content-Length", String(meta.size))
          headers.set("Content-Type", meta.contentType)
          headers.set("X-Content-Type-Options", "nosniff")
          return new Response(null, { headers })
        }

        const cached = cachePath
          ? await driver.get(cachePath).catch((error) => {
            logCacheFailure("transform-cache-read", "Blob transform cache read failed", error, () => console.error("[vitehub/blob] Transform cache read failed", error), request)
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
                  logCacheFailure("transform-cache-write", "Blob transform cache write failed", error, () => console.error("[vitehub/blob] Transform cache write failed", error), request)
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
        let status = 200
        if (!transform) {
          headers.set("Accept-Ranges", "bytes")
          const range = selectByteRange(request, etag, body.size)
          if (range === "unsatisfiable") {
            headers.set("Content-Range", `bytes */${body.size}`)
            body = new Blob([])
            status = 416
          }
          else if (range) {
            headers.set("Content-Range", `bytes ${range.start}-${range.end}/${body.size}`)
            body = body.slice(range.start, range.end + 1, body.type)
            status = 206
          }
        }
        const contentType = transform
          ? body.type || "application/octet-stream"
          : meta.contentType || body.type || guessContentType(normalizedPath)
        headers.set("X-Content-Type-Options", "nosniff")
        headers.set("Content-Length", String(body.size))
        headers.set("Content-Type", contentType)
        sandboxActiveContent(headers, options, contentType)
        // A HEAD response has the headers of the GET response and no body.
        return new Response(request.method === "HEAD" ? null : body.stream(), { headers, status })
      })
      if (error) return [error, undefined]
      if (payload === false) continue
      return payload === undefined
        ? [blobError("BLOB_NOT_FOUND", "serve", store), undefined]
        : [undefined, payload]
    }
    return blobResult("serve", store, async () => {
      throw blobErrorDiagnostics.BLOB_OBJECT_CHANGED_DURING_READ({ step: "response" })
    })
  }
  return storage
}
