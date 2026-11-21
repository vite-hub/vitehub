import { RealtimeDocumentConflict } from "./conflict.ts"
import { realtimeErrorDiagnostics } from "./error-diagnostics.ts"

import type { RealtimeDocumentAdapter } from "./types.ts"

/**
 * The part of a ViteHub Blob store that `blobDocument()` uses, such as `blob` from `vite-hub/blob`. `put()` writes only
 * when its `ifMatch` or `overwrite: false` condition holds, and otherwise returns a `BLOB_CONFLICT` error.
 */
export interface RealtimeBlobStore {
  get(pathname: string): Promise<[error: unknown, value: Blob | null | undefined]>
  head(pathname: string): Promise<[error: unknown, value: { httpEtag: string | undefined } | null | undefined]>
  put(
    pathname: string,
    body: string,
    options: { contentType: string, ifMatch: string } | { contentType: string, overwrite: false },
  ): Promise<[error: unknown, value: unknown]>
}

export interface RealtimeBlobDocumentOptions {
  /** Defaults to `text/markdown; charset=utf-8`. */
  contentType?: string
  /** Prepended to the document id to make the Blob pathname. Defaults to none. */
  prefix?: string
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined
}

async function digestOf(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * Stores each Realtime document as one Blob file at `prefix + documentId`. Its digest is the SHA-256 of the
 * body. `save()` reads the stored file and throws `RealtimeDocumentConflict` when its digest is not `ifDigest`. It
 * writes only if the file still has the ETag that it read, so a writer outside the room that writes between that read
 * and the save's write also makes the save throw `RealtimeDocumentConflict`, and keeps its file.
 */
export function blobDocument(store: RealtimeBlobStore, options: RealtimeBlobDocumentOptions = {}): RealtimeDocumentAdapter {
  const { contentType = "text/markdown; charset=utf-8", prefix = "" } = options
  // Blob decodes a pathname once, so `a%2Fb.md` would open `a/b.md`. Escaping `%` keeps each document id its own file.
  const pathnameOf = (documentId: string) => (prefix + documentId).replaceAll("%", "%25")
  const read = async (pathname: string) => {
    const [error, file] = await store.get(pathname)
    if (errorCode(error) === "BLOB_NOT_FOUND") return null
    if (error) throw error
    return file ? await file.text() : null
  }
  return {
    kind: "blob",
    async load({ documentId }) {
      const body = await read(pathnameOf(documentId))
      return { body: body ?? "", digest: body === null ? null : await digestOf(body) }
    },
    async save({ documentId }, { body }, { ifDigest }) {
      const pathname = pathnameOf(documentId)
      // The ETag comes before the body. A write between the two reads gives an old ETag, so the put fails and nothing is lost.
      const [headError, object] = await store.head(pathname)
      if (headError && errorCode(headError) !== "BLOB_NOT_FOUND") throw headError
      const stored = object ? await read(pathname) : null
      if ((stored === null ? null : await digestOf(stored)) !== ifDigest) {
        throw new RealtimeDocumentConflict(stored === null
          ? "The Blob file of this document was deleted after the realtime room loaded it."
          : "The Blob file of this document changed after the realtime room loaded it.")
      }
      const etag = object?.httpEtag
      if (object && !etag) throw realtimeErrorDiagnostics.REALTIME_BLOB_ETAG_MISSING({ pathname })
      const [error] = await store.put(pathname, body, etag ? { contentType, ifMatch: etag } : { contentType, overwrite: false })
      if (errorCode(error) === "BLOB_CONFLICT") {
        throw new RealtimeDocumentConflict("Another writer changed the Blob file of this document while the realtime room saved it.")
      }
      if (error) throw error
      return { digest: await digestOf(body) }
    },
  }
}
