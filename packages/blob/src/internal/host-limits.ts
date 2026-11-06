import type { BlobDriverAdapter } from "../types.ts"

// Cloudflare documents the object key length at https://developers.cloudflare.com/r2/platform/limits/.
const r2KeyBytes = 1024
// Vercel documents the request body limit of a Function at https://vercel.com/docs/functions/limitations.
// It names 4.5 MB, so the dev server counts 4,500,000 bytes.
export const vercelFunctionRequestBodyBytes = 4_500_000

const requestBodyLimitKey = Symbol.for("vitehub.blob.request-body-limit")

/**
 * Sets the most bytes that `handleUpload()` and `handleMultipartUpload()` read from one request. The generated Nitro
 * plugin of a dev server for Vercel sets it, because Vercel rejects a larger request before the Function runs.
 */
export function setBlobRequestBodyLimit(bytes: number | undefined): void {
  Reflect.set(globalThis, requestBodyLimitKey, bytes)
}

export function getBlobRequestBodyLimit(): number | undefined {
  const bytes: unknown = Reflect.get(globalThis, requestBodyLimitKey)
  return typeof bytes === "number" ? bytes : undefined
}

const encoder = /*#__PURE__*/ new TextEncoder()

/** The error that a driver throws for a pathname above its host limit. `blobResult()` returns it as `BLOB_PATHNAME_TOO_LONG`. */
export class BlobPathnameTooLongError extends Error {
  constructor(bytes: number, limit: number) {
    super(`The pathname is ${bytes} bytes in UTF-8. Cloudflare R2 accepts object keys of at most ${limit} bytes.`)
    this.name = "BlobPathnameTooLongError"
  }
}

function assertR2Key(pathname: string): string {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so a short pathname cannot exceed the limit.
  if (pathname.length * 3 <= r2KeyBytes) return pathname
  const bytes = encoder.encode(pathname).byteLength
  if (bytes > r2KeyBytes) throw new BlobPathnameTooLongError(bytes, r2KeyBytes)
  return pathname
}

/** Checks each pathname before an R2 driver gets it, so dev and production return the same code. Other drivers are unchanged. */
export function withHostPathnameLimits<TOptions>(driver: BlobDriverAdapter<TOptions>): BlobDriverAdapter<TOptions> {
  if (driver.name !== "cloudflare-r2") return driver
  const { createMultipartUpload, getStream, resumeMultipartUpload, sign } = driver
  return {
    ...driver,
    delete: pathnames => driver.delete(Array.isArray(pathnames) ? pathnames.map(assertR2Key) : assertR2Key(pathnames)),
    get: pathname => driver.get(assertR2Key(pathname)),
    getArrayBuffer: pathname => driver.getArrayBuffer(assertR2Key(pathname)),
    head: pathname => driver.head(assertR2Key(pathname)),
    put: (pathname, body, options) => driver.put(assertR2Key(pathname), body, options),
    ...(createMultipartUpload ? { createMultipartUpload: (pathname, options) => createMultipartUpload.call(driver, assertR2Key(pathname), options) } : {}),
    ...(getStream ? { getStream: (pathname, options) => getStream.call(driver, assertR2Key(pathname), options) } : {}),
    ...(resumeMultipartUpload ? { resumeMultipartUpload: (pathname, uploadId) => resumeMultipartUpload.call(driver, assertR2Key(pathname), uploadId) } : {}),
    ...(sign ? { sign: (pathname, options) => sign.call(driver, assertR2Key(pathname), options) } : {}),
  }
}
