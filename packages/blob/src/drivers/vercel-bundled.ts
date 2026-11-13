import { BlobNotFoundError, completeMultipartUpload, copy, createMultipartUpload, del, get, head, list, put, uploadPart } from "@vercel/blob"

import { isPlainObject } from "@vite-hub/internal/object"

import type { BlobDriverAdapter, BlobDriverMultipartUpload, BlobObject, BlobPutBody, BlobPutOptions, BlobSignedRequest, BlobSignOptions, ResolvedVercelBlobStoreConfig } from "../types.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"
import isBlob from "../internal/is-blob.ts"
import { blobSizeToBytes } from "../internal/size.ts"

// Vercel needs the object key and upload ID on every multipart call, so the public upload ID carries both.
// The client returns this ID, so it holds no authority: access always comes from the store config.
interface VercelMultipartState {
  contentType?: string
  key: string
  uploadId: string
}

const multipartStateEncoding = "v1."

function encodeMultipartState(state: VercelMultipartState): string {
  const bytes = new TextEncoder().encode(JSON.stringify(state))
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return multipartStateEncoding + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

function decodeMultipartState(uploadId: string): VercelMultipartState {
  try {
    const isUtf8 = uploadId.startsWith(multipartStateEncoding)
    const encoded = (isUtf8 ? uploadId.slice(multipartStateEncoding.length) : uploadId).replaceAll("-", "+").replaceAll("_", "/")
    const binary = atob(encoded + "=".repeat((4 - encoded.length % 4) % 4))
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const parseState = (value: unknown): VercelMultipartState | undefined => {
      if (!isPlainObject(value)) return undefined
      const { contentType, key, uploadId: id } = value
      if (typeof key === "string" && typeof id === "string" && (contentType === undefined || typeof contentType === "string")) {
        return { contentType, key, uploadId: id }
      }
      return undefined
    }
    // IDs generated before UTF-8 encoding used the binary character values directly.
    // The marker makes new UTF-8 state unambiguous, including literal U+FFFD values.
    const state = parseState(JSON.parse(isUtf8 ? new TextDecoder().decode(bytes) : binary))
    if (state) return state
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

// The SDK maps the Vercel Blob API code `not_found` to this class. Its `name` stays "Error",
// so the class is the only typed signal. The driver and the SDK share one module instance.
function isMissingBlobError(error: unknown) {
  return error instanceof BlobNotFoundError
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

// The Vercel Blob API version that `@vercel/blob` 2.8 sends. A signed request replays what its client `upload()` sends.
const vercelBlobApiVersion = "12"

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/**
 * The client token of `generateClientTokenFromReadWriteToken()` in `@vercel/blob/client`: an HMAC-SHA256 of the
 * payload with the read-write token. Web Crypto keeps Node's `crypto` module out of Worker and standalone bundles.
 */
async function vercelClientToken(readWriteToken: string, payload: Record<string, unknown>): Promise<string> {
  const storeId = readWriteToken.split("_")[3]
  if (!storeId) {
    throw blobErrorDiagnostics.BLOB_R0025({ message: "Blob driver \"vercel-blob\" cannot sign: the read-write token has no store ID. Use the BLOB_READ_WRITE_TOKEN of the store." })
  }
  const encoder = new TextEncoder()
  const body = base64(encoder.encode(JSON.stringify(payload)))
  const key = await globalThis.crypto.subtle.importKey("raw", encoder.encode(readWriteToken), { hash: "SHA-256", name: "HMAC" }, false, ["sign"])
  const signature = Array.from(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(body))), byte => byte.toString(16).padStart(2, "0")).join("")
  return `vercel_blob_client_${storeId}_${base64(encoder.encode(`${signature}.${body}`))}`
}

/**
 * Signs a `PUT` the way `@vercel/blob/client` uploads a file: a client token from the read-write token, which Vercel
 * checks for the pathname, the content type, the size, and the expiry. The browser sends it to the Vercel Blob API.
 */
async function signVercelUpload(options: ResolvedVercelBlobStoreConfig, pathname: string, signOptions: BlobSignOptions): Promise<BlobSignedRequest> {
  if (signOptions.method === "GET") {
    throw blobErrorDiagnostics.BLOB_R0025({ message: "Blob driver \"vercel-blob\" cannot sign a GET request. Serve the object through `blob.serve()`." })
  }
  const token = options.token || globalThis.process?.env?.BLOB_READ_WRITE_TOKEN
  if (!token) {
    throw blobErrorDiagnostics.BLOB_R0025({ message: "Blob driver \"vercel-blob\" signs uploads with a read-write token. Set BLOB_READ_WRITE_TOKEN: a store that only uses Vercel OIDC cannot sign." })
  }
  const allowOverwrite = !signOptions.createOnly && (options.allowOverwrite ?? true)
  const clientToken = await vercelClientToken(token, {
    addRandomSuffix: false,
    allowedContentTypes: signOptions.contentType ? [signOptions.contentType] : undefined,
    allowOverwrite,
    maximumSizeInBytes: signOptions.maxSize === undefined ? undefined : blobSizeToBytes(signOptions.maxSize),
    pathname,
    validUntil: Date.now() + signOptions.expiresIn * 1000,
  })
  const apiUrl = globalThis.process?.env?.VERCEL_BLOB_API_URL || "https://vercel.com/api/blob"
  const headers: Record<string, string> = {
    "authorization": `Bearer ${clientToken}`,
    "x-add-random-suffix": "0",
    "x-allow-overwrite": allowOverwrite ? "1" : "0",
    "x-api-version": vercelBlobApiVersion,
    "x-vercel-blob-access": options.access,
  }
  if (signOptions.contentType) {
    headers["Content-Type"] = signOptions.contentType
    headers["x-content-type"] = signOptions.contentType
  }
  return { headers, method: "PUT", url: `${apiUrl}/?${new URLSearchParams({ pathname })}` }
}

export function createBundledVercelBlobDriver(options: ResolvedVercelBlobStoreConfig): BlobDriverAdapter<ResolvedVercelBlobStoreConfig> {
  const auth = options.token ? { token: options.token } : {}

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
    // Vercel Blob copies on the server, but does not keep the content type, so it reads it first.
    async copy(from, to) {
      try {
        const source = await head(from, auth)
        const result = await copy(source.url, to, {
          ...auth,
          access: options.access,
          addRandomSuffix: false,
          allowOverwrite: options.allowOverwrite ?? true,
          contentType: source.contentType,
        })
        return toBlobObject(await head(result.url, auth))
      }
      catch (error) {
        if (isMissingBlobError(error)) return null
        throw error
      }
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
      const folded = listOptions.folded
      const result = await list<"folded" | undefined>({
        ...auth,
        cursor: listOptions.cursor,
        limit: listOptions.limit,
        ...(folded ? { mode: "folded" } : {}),
        prefix: listOptions.prefix,
      })
      return {
        blobs: result.blobs.map(toBlobObject),
        cursor: result.cursor,
        ...(folded && "folders" in result ? { folders: result.folders } : {}),
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
    sign: (pathname, signOptions) => signVercelUpload(options, pathname, signOptions),
  }
}

export { createBundledVercelBlobDriver as createDriver }
