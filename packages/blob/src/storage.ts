import { literal, object, parse, string } from "valibot"

import { toArray } from "@vite-hub/internal/arrays"
import { vitehubOwnedPrefix } from "@vite-hub/internal/owned-paths"

import { blobError, blobResult } from "./errors.ts"
import { handleBlobMultipartUpload, handleBlobUpload, validateMultipartParts } from "./upload.ts"

// Generated provider runtime modules import the handlers from this entry.
export { handleBlobMultipartUpload, handleBlobUpload }
export { createLazyBlobMedia } from "./media/lazy.ts"
export { blobStoreMode, readonlyBlobStorage } from "./readonly.ts"

import type { Result } from "@vite-hub/runtime"

import type { BlobDriverAdapter, BlobDriverByteRange, BlobDriverMultipartUpload, BlobErrorCode, BlobListOptions, BlobMultipartUpload, BlobObject, BlobPutBody, BlobPutOptions, BlobServeResponseOptions, BlobStorage } from "./types.ts"
import type { BlobImagesOptions, BlobImageTransformer } from "./media/types.ts"
import { blobErrorDiagnostics } from "./error-diagnostics.ts"
import { attachmentDisposition, isActiveContentType } from "./internal/active-content.ts"
import { byteRangeBounds } from "./internal/byte-range.ts"
import isBlob from "./internal/is-blob.ts"
import { readDerivedHeader } from "./internal/derived-header.ts"
import { withHostPathnameLimits } from "./internal/host-limits.ts"
import { assertValidPathname, pathnameIssue } from "./internal/pathname.ts"
import { blobSizeToBytes } from "./internal/size.ts"
import { createBlobMedia } from "./media/records.ts"
import { resolveBlobImages } from "./media/transformers.ts"

// S3, R2, and Vercel Blob all accept part numbers 1 through 10000.
const maxPartNumber = 10_000

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

// Decode the pathname once. A pathname that is not valid percent-encoding stays as it is.
function decodePathname(pathname: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  }
  catch {
    decoded = pathname
  }
  return decoded.replace(/^\/+/, "")
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

function assertWritablePath(pathname: string) {
  if (isReservedPath(pathname)) {
    throw blobErrorDiagnostics.BLOB_R0033({ message: "Blob pathname uses a reserved ViteHub namespace: .vitehub, _vitehub/derived, or _vitehub/media." })
  }
}

// `access` was a put() option that only Vercel Blob read. Other drivers dropped it and served the object anyway.
function assertNoPutAccess(options: object) {
  if (Object.hasOwn(options, "access")) {
    throw blobErrorDiagnostics.BLOB_R0045({ message: "`access` is not a Blob put() option. One object cannot be private on its own: the store and `blob.serve` decide who may read it." })
  }
}

function blobErrorResponse(request: Request, status: 400 | 404, error: string): Response {
  const response = Response.json({ error }, { status })
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

/** Reads one `Range: bytes=` spec. Returns `undefined` for no range, several ranges, or a malformed header. */
function parseByteRange(header: string | null): BlobDriverByteRange | undefined {
  if (!header) return
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return
  if (!match[1]) return { suffix: Number(match[2]) }
  const offset = Number(match[1])
  if (!match[2]) return { offset }
  const end = Number(match[2])
  return end < offset ? undefined : { offset, length: end - offset + 1 }
}

/**
 * Selects the bytes to send. Returns `undefined` to send the whole body: no range, several ranges, a stale `If-Range`,
 * or a malformed header. Browsers need ranges to seek media, and Safari does not play video without them.
 */
function selectByteRange(request: Request, etag: string | undefined, size: number): { start: number, end: number } | "unsatisfiable" | undefined {
  // RFC 9110 section 14.2 requires ignoring Range on methods other than GET.
  if (request.method !== "GET") return
  const range = parseByteRange(request.headers.get("range"))
  if (!range) return
  const ifRange = request.headers.get("if-range")
  // Only a strong ETag can validate If-Range. Without a match, send the current whole body.
  if (ifRange !== null && (!etag || ifRange !== etag)) return
  return byteRangeBounds(range, size) ?? "unsatisfiable"
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
  const target = options.driver === "vercel-blob"
    ? "Vercel Blob store"
    : options.driver === "cloudflare-r2" ? `R2 bucket${bucket}` : `\`${String(options.driver)}\` store`
  console.warn(`[vitehub] Blob store "${store}" is remote: \`vite dev\` uses the real ${target}. Writes change real data.`)
}

export function createBlobStorage(hostDriver: BlobDriverAdapter<any>, store: string = hostDriver.name, options: BlobStorageOptions = {}): BlobStorage {
  warnRemoteStore(hostDriver.options, store)
  const driver = withHostPathnameLimits(hostDriver)
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
      copy: (from, to, copyOptions) => storage.copy(from, to, copyOptions),
      delete: pathnames => storage.delete(pathnames),
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
    async delete(pathnames: string | string[]) {
      const normalizedPathnames = toArray(pathnames).map(value => normalizePathname(value))
      return blobResult("delete", store, async () => {
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
      assertNoPutAccess(options)
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
      if (options.method === "PUT" && options.maxSize !== undefined && blobSizeToBytes(options.maxSize) === undefined) {
        throw blobErrorDiagnostics.BLOB_R0039({ message: `\`maxSize\` must be a size such as "8MB". Received ${JSON.stringify(options.maxSize)}.` })
      }
      if (!driver.sign) {
        throw blobErrorDiagnostics.BLOB_R0025({ message: `Blob driver "${driver.name}" does not support signed requests.` })
      }
      const normalizedPathname = normalizePathname(pathname)
      if (options.method === "PUT") assertWritablePath(normalizedPathname)
      return blobResult("sign", store, () => driver.sign!(normalizedPathname, options, { store }))
    },
    async serve(request, pathname, options = {}) {
      const decodedPath = decodePathname(pathname)
      const issue = pathnameIssue(decodedPath)
      if (issue) return blobErrorResponse(request, 400, `Invalid Blob pathname: it ${issue}.`)
      if (isReservedPath(decodedPath)) return blobErrorResponse(request, 404, "Blob not found.")
      const [error, response] = await serveRequest(request, decodedPath, options)
      if (!error) return response
      if (error.code === "BLOB_NOT_FOUND") return blobErrorResponse(request, 404, "Blob not found.")
      if (error.code === "BLOB_PATHNAME_TOO_LONG") return blobErrorResponse(request, 400, error.message)
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
    if (options.download !== undefined && options.download !== false) {
      headers.set("Content-Disposition", attachmentDisposition(options.download === true ? normalizedPath : options.download))
    }
    return headers
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
      // Internal invariant: blobResult() returns this as the cause of BLOB_OPERATION_FAILED.
      throw new Error("Blob changed repeatedly while preparing its response.")
    })
  }
  return storage
}
