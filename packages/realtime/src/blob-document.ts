import { RealtimeDocumentConflict } from "./conflict.ts"

import type { RealtimeDocumentAdapter } from "./types.ts"

/** The part of a ViteHub Blob store that `blobDocument()` uses, such as `blob` from `vite-hub/blob`. */
export interface RealtimeBlobStore {
  get(pathname: string): Promise<[error: unknown, value: Blob | null | undefined]>
  put(pathname: string, body: string, options: { access: "private", contentType: string }): Promise<[error: unknown, value: unknown]>
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
 * Stores each Realtime document as one private Blob file at `prefix + documentId`. Its digest is the SHA-256 of the
 * body. `save()` reads the stored file and throws `RealtimeDocumentConflict` when its digest is not `ifDigest`.
 * Blob has no conditional write, so a writer outside the room that writes between that read and the save's write is
 * overwritten. The room itself saves one at a time.
 */
export function blobDocument(store: RealtimeBlobStore, options: RealtimeBlobDocumentOptions = {}): RealtimeDocumentAdapter {
  const { contentType = "text/markdown; charset=utf-8", prefix = "" } = options
  const read = async (pathname: string) => {
    const [error, file] = await store.get(pathname)
    if (errorCode(error) === "BLOB_NOT_FOUND") return null
    if (error) throw error
    return file ? await file.text() : null
  }
  return {
    kind: "blob",
    async load({ documentId }) {
      const body = await read(prefix + documentId)
      return { body: body ?? "", digest: body === null ? null : await digestOf(body) }
    },
    async save({ documentId }, { body }, { ifDigest }) {
      const pathname = prefix + documentId
      const stored = await read(pathname)
      if ((stored === null ? null : await digestOf(stored)) !== ifDigest) {
        throw new RealtimeDocumentConflict(stored === null
          ? "The Blob file of this document was deleted after the realtime room loaded it."
          : "The Blob file of this document changed after the realtime room loaded it.")
      }
      const [error] = await store.put(pathname, body, { access: "private", contentType })
      if (error) throw error
      return { digest: await digestOf(body) }
    },
  }
}
