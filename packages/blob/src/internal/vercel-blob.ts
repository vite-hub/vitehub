import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob"

/** The part of the Vercel Blob SDK that Workspace calls. The narrow type keeps the SDK declarations out of this entry. */
export interface VercelBlobSdk {
  // The SDK maps the Vercel Blob API code `not_found` to this class. Its `name` stays "Error".
  BlobNotFoundError: abstract new (...args: never[]) => Error
  del(key: string, options?: { token?: string }): Promise<void>
  get(key: string, options: { access: "private" | "public", token?: string, useCache?: boolean, headers?: Record<string, string> }): Promise<{
    blob: { contentType: string, size: number }
    statusCode: 200
    stream: ReadableStream<Uint8Array>
  } | { statusCode: 304, stream: null } | null>
  head(key: string, options?: { token?: string }): Promise<{ contentType?: string, pathname: string, size: number, uploadedAt: Date }>
  list(options: { cursor?: string, limit?: number, prefix: string, token?: string }): Promise<{
    blobs: Array<{ pathname: string, size?: number, uploadedAt?: Date }>
    cursor?: string
    hasMore?: boolean
  }>
  put(key: string, body: Blob | Uint8Array | string, options: {
    access: "private" | "public"
    addRandomSuffix: boolean
    allowOverwrite: boolean
    contentType?: string
    token?: string
  }): Promise<unknown>
}

/** Workspace stores files in Vercel Blob through this SDK copy, so an app with both packages ships the SDK once. */
export const vercelBlob: VercelBlobSdk = {
  BlobNotFoundError,
  del,
  get,
  head,
  list,
  // SAFETY: The SDK sends a Uint8Array body as it is. Its type names only Buffer.
  put: (key, body, options) => put(key, body as Parameters<typeof put>[1], options),
}
