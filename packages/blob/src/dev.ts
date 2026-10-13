/** Vite Development Server route that `vitehub blob` commands call. */
export const blobDevRoute = "/__vitehub/blob/dev"
/** Nitro route that the dev endpoint forwards Blob operations to. The route exists only in `vite dev`. */
export const blobDevRuntimeRoute = "/_vitehub/blob/dev"
export const blobDevHeader = "x-vitehub-blob-dev"
export const blobDevHeaderValue = "1"
export const blobDevTokenNamespace = "blob"
export const blobDevTokenServerHeader = "x-vitehub-blob-dev-server"
/**
 * Response header of a successful `get`. The body is the raw file, and this header holds the URI-encoded JSON of
 * {@link BlobDevFileHeader}.
 */
export const blobDevFileHeader = "x-vitehub-blob-dev-file"

/** Blob operations that the dev endpoint accepts. `sign` is not available through the CLI. */
export const blobDevOperations = ["list", "head", "get", "put", "del"] as const

export type BlobDevOperation = typeof blobDevOperations[number]

/** Largest `--limit` of one `list` page. The Console uses the same maximum. */
export const blobDevMaximumListLimit = 250
/** Default `--limit` of one `list` page. */
export const blobDevDefaultListLimit = 100
/**
 * Largest file that `put` accepts. The Vite dev endpoint forwards a JSON body, so the file travels as base64 and
 * the whole request stays in memory. Use the application or the provider tools for larger files.
 */
export const blobDevMaximumUploadBytes = 8 * 1024 * 1024

export interface BlobDevRequestBody {
  /** Content type for `put`. Without it, the Blob storage detects the type from the pathname. */
  contentType?: string
  cursor?: string
  /** File data for `put`, as base64. */
  data?: string
  limit?: number
  operation: BlobDevOperation
  pathname?: string
  prefix?: string
  /** Store name. Defaults to `default`. */
  store?: string
}

/** Metadata of a `get` response. The body holds the file bytes. */
export interface BlobDevFileHeader {
  contentType?: string
  pathname: string
  size: number
  store: string
}

export function isBlobDevOperation(value: unknown): value is BlobDevOperation {
  return blobDevOperations.some(operation => operation === value)
}
