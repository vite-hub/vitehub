/** The operations that `vitehub blob` runs, without the `blob.` prefix. `sign` is not available through the CLI. */
export const blobOperationNames = ["list", "head", "get", "put", "del", "media", "variants"] as const

export type BlobDevOperation = typeof blobOperationNames[number]

/** Largest `--limit` of one `list` page. The Console uses the same maximum. */
export const blobDevMaximumListLimit = 250
/** Default `--limit` of one `list` page. */
export const blobDevDefaultListLimit = 100
/**
 * Largest file that `put` accepts and `get` returns. A call carries the file as base64 in JSON, so the whole request
 * stays in memory. Use the application or the provider tools for larger files.
 */
export const blobDevMaximumUploadBytes = 8 * 1024 * 1024
/** Largest request of `blob.put`: the base64 text of the largest file, and the other fields. */
export const blobPutRequestBytes: number = Math.ceil(blobDevMaximumUploadBytes * 4 / 3) + 16 * 1024
