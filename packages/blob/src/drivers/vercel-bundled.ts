import { completeMultipartUpload, createMultipartUpload, del, get, head, list, put, uploadPart } from "@vercel/blob"

import { isPlainObject } from "@vite-hub/internal/object"

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobObject, BlobPutBody, BlobPutOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import isBlob from "../internal/is-blob.ts"

// Vercel needs the object key and upload ID on every multipart call, so the public upload ID carries both.
// The client returns this ID, so it holds no authority: access always comes from the store config.
interface VercelMultipartState {
  contentType?: string
  key: string
  uploadId: string
}

function encodeMultipartState(state: VercelMultipartState): string {
  return btoa(JSON.stringify(state)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function decodeMultipartState(uploadId: string): VercelMultipartState {
  try {
    const value: unknown = JSON.parse(atob(uploadId.replaceAll("-", "+").replaceAll("_", "/")))
    if (isPlainObject(value)) {
      const { contentType, key, uploadId: id } = value
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The upload ID comes from the client and is checked before use.
      if (typeof key === "string" && typeof id === "string" && (contentType === undefined || typeof contentType === "string")) {
        return { contentType, key, uploadId: id }
      }
    }
  }
  catch {}
  throw blobErrorDiagnostics.BLOB_R0032({ message: "Unknown Vercel Blob multipart upload." })
}

function toBlobObject(blob: {
  contentType?: string
  etag?: string
  pathname: string
  size: number
  uploadedAt: Date
  url?: string
}): BlobObject {
  return {
    contentType: blob.contentType,
    customMetadata: {},
    httpEtag: blob.etag,
    httpMetadata: blob.contentType ? { contentType: blob.contentType } : {},
    pathname: blob.pathname,
    size: blob.size,
    uploadedAt: blob.uploadedAt,
    url: blob.url,
  }
}

function isMissingBlobError(error: unknown) {
  if (error === null || Object(error) !== error) return false
  const candidate = Object(error)
  try {
    const nativeIsError: unknown = Reflect.get(Error, "isError")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Error.isError is optional in supported runtimes; prefer its native state check when available.
    const isError = typeof nativeIsError === "function"
      ? nativeIsError(error) === true
      : (() => {
          const stack = Object.getOwnPropertyDescriptor(candidate, "stack")
          // Native errors expose their lazily materialized stack through an intrinsic
          // accessor. Verify the accessor's intrinsic behavior rather than its identity:
          // each realm has a distinct native getter, while a forged or bound getter can
          // return a stack for an object that has no Error state.
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The descriptor is validated before reading its getter.
          if (!stack || typeof stack.get !== "function") return false
          let nativeErrorConstructor: unknown
          const seen = new Set<object>()
          let prototype = Object.getPrototypeOf(candidate)
          for (let depth = 0; depth < 64 && prototype !== null && prototype !== Object.prototype; depth++) {
            if (seen.has(prototype)) return false
            seen.add(prototype)
            const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value
            if (Object.prototype.toString.call(constructor) === "[object Function]"
              && Object.getOwnPropertyDescriptor(constructor, "prototype")?.value === prototype
              && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Error)) {
              nativeErrorConstructor = constructor
              break
            }
            prototype = Object.getPrototypeOf(prototype)
          }
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The legacy path validates the constructor before invoking it.
          if (typeof nativeErrorConstructor !== "function") return false
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The descriptor is validated before reading its getter.
          if (typeof stack.get !== "function") return false
          const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get
          // Cross-realm native accessors have the same intrinsic source text, while
          // receiver-sensitive functions cannot impersonate that native accessor.
          if (typeof nativeStackGetter !== "function"
            || Function.prototype.toString.call(stack.get) !== Function.prototype.toString.call(nativeStackGetter)) return false
          // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The native getter result is the legacy brand check.
          if (typeof stack.get.call(candidate) !== "string") return false
          // A genuine native getter returns no stack for an object which merely shares
          // the Error prototype. Bound and forged getters instead return their captured
          // or fabricated value, so they cannot establish the candidate's Error brand.
          if (stack.get.call(Object.create(prototype)) !== undefined) return false
          if (stack.get.call(new Proxy(candidate, {})) !== undefined) return false
          return true
        })()
    if (!isError) return false
    if (Reflect.get(candidate, "name") === "BlobNotFoundError") return true
    const message: unknown = Reflect.get(candidate, "message")
    // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The SDK exposes the missing-object diagnostic in its opaque Error message.
    return typeof message === "string" && /(?:requested )?blob (?:was )?not found|requested blob does not exist/i.test(message)
  }
  catch {
    return false
  }
}

function resolveBlobAccess(url: string, fallback: "private" | "public") {
  try {
    const hostname = new URL(url).hostname
    if (hostname.endsWith(".private.blob.vercel-storage.com")) return "private"
    if (hostname.endsWith(".public.blob.vercel-storage.com")) return "public"
  }
  catch {}
  return fallback
}

export function createBundledVercelBlobDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  const auth = { token: options.token }

  async function read(pathname: string) {
    const abortSignal = options.downloadTimeoutMs && options.downloadTimeoutMs > 0
      ? AbortSignal.timeout(options.downloadTimeoutMs)
      : undefined
    try {
      const metadata = await head(pathname, { ...auth, abortSignal })
      const result = await get(metadata.url, {
        ...auth,
        abortSignal,
        access: resolveBlobAccess(metadata.url, options.access),
      })
      return result ? new Response(result.stream, { headers: result.blob.contentType ? { "content-type": result.blob.contentType } : undefined }) : null
    }
    catch (error) {
      if (isMissingBlobError(error)) return null
      throw error
    }
  }

  function multipartUpload(pathname: string, state: VercelMultipartState): BlobDriverMultipartUpload {
    const partOptions = { ...auth, access: options.access, key: state.key, uploadId: state.uploadId }
    return {
      pathname,
      uploadId: encodeMultipartState(state),
      // Vercel Blob has no abort call; the service discards unfinished uploads.
      async abort() {},
      async complete(parts) {
        const result = await completeMultipartUpload(pathname, parts, { ...partOptions, contentType: state.contentType })
        return toBlobObject(await head(result.url, auth))
      },
      async uploadPart(partNumber, body) {
        // SAFETY: The multipart protocol passes a Blob-compatible body to the Vercel SDK.
        const part = await uploadPart(pathname, body as Parameters<typeof uploadPart>[1], { ...partOptions, partNumber })
        return { etag: part.etag, partNumber: part.partNumber }
      },
    }
  }

  return {
    name: options.driver,
    options,
    async createMultipartUpload(pathname, multipartOptions) {
      if (multipartOptions.customMetadata && Object.keys(multipartOptions.customMetadata).length > 0) {
        throw blobErrorDiagnostics.BLOB_R0011({ message: "The Vercel Blob driver does not support custom metadata" })
      }
      const created = await createMultipartUpload(pathname, {
        ...auth,
        access: options.access,
        addRandomSuffix: false,
        allowOverwrite: options.allowOverwrite ?? true,
        contentType: multipartOptions.contentType,
      })
      return multipartUpload(pathname, { contentType: multipartOptions.contentType, key: created.key, uploadId: created.uploadId })
    },
    async resumeMultipartUpload(pathname, uploadId) {
      return multipartUpload(pathname, decodeMultipartState(uploadId))
    },
    async delete(pathnames) {
      await del(pathnames, auth)
    },
    async get(pathname) {
      return await (await read(pathname))?.blob() || null
    },
    async getArrayBuffer(pathname) {
      return await (await read(pathname))?.arrayBuffer() || null
    },
    async head(pathname) {
      try {
        return toBlobObject(await head(pathname, auth))
      }
      catch (error) {
        if (isMissingBlobError(error)) return null
        throw error
      }
    },
    async list(listOptions = {}) {
      if (listOptions.folded) {
        const result = await list({
          ...auth,
          cursor: listOptions.cursor,
          limit: listOptions.limit,
          mode: "folded",
          prefix: listOptions.prefix,
        })
        return {
          blobs: result.blobs.map(toBlobObject),
          cursor: result.cursor,
          folders: result.folders,
          hasMore: result.hasMore,
        }
      }
      const result = await list({
        ...auth,
        cursor: listOptions.cursor,
        limit: listOptions.limit,
        prefix: listOptions.prefix,
      })
      return {
        blobs: result.blobs.map(toBlobObject),
        cursor: result.cursor,
        hasMore: result.hasMore,
      }
    },
    async put(pathname, body: BlobPutBody, putOptions: BlobPutOptions = {}) {
      if (putOptions.customMetadata && Object.keys(putOptions.customMetadata).length > 0) {
        throw blobErrorDiagnostics.BLOB_R0011({ message: "The Vercel Blob driver does not support custom metadata" })
      }
      const result = await put(pathname, body as Parameters<typeof put>[1], {
        ...auth,
        access: putOptions.access || options.access,
        addRandomSuffix: false,
        allowOverwrite: options.allowOverwrite ?? true,
        contentType: putOptions.contentType,
      })
      let size = typeof body === "string"
        ? new TextEncoder().encode(body).byteLength
        : isBlob(body)
          ? body.size
          : body instanceof ArrayBuffer || ArrayBuffer.isView(body)
            ? body.byteLength
            : Number(putOptions.contentLength) || 0
      let uploadedAt = new Date()
      let httpEtag = (result as typeof result & { etag?: string }).etag
      if (!size) {
        const metadata = await head(result.url, auth)
        size = metadata.size
        uploadedAt = metadata.uploadedAt
        httpEtag ||= metadata.etag
      }
      const contentType = result.contentType || putOptions.contentType
      const httpMetadata: Record<string, string> = {}
      if (contentType) httpMetadata.contentType = contentType
      return {
        contentType,
        customMetadata: {},
        httpEtag,
        httpMetadata,
        pathname: result.pathname,
        size,
        uploadedAt,
        url: result.url,
      }
    },
  }
}

export { createBundledVercelBlobDriver as createDriver }
