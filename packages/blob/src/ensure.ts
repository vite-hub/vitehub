import { createError } from "h3"

import { isActiveContentType } from "./internal/active-content.ts"
import { blobSizeToBytes } from "./internal/size.ts"

import type { BlobEnsureOptions, BlobType } from "./types.ts"

function fileSizeToBytes(input: string) {
  const bytes = blobSizeToBytes(input)
  if (bytes === undefined) {
    throw createError({ statusCode: 400, message: `Invalid file size format: ${input}` })
  }
  return bytes
}

function requireEnsureOptions(options: BlobEnsureOptions): void {
  if (!options.maxSize && !options.types?.length) {
    throw createError({
      statusCode: 400,
      message: "ensureBlob() requires at least one of maxSize or types to be set.",
    })
  }
}

/** Bytes that `options.maxSize` allows, or `undefined` without a limit. Throws 400 for a malformed size. */
export function ensureMaxBytes(options: BlobEnsureOptions): number | undefined {
  requireEnsureOptions(options)
  return options.maxSize ? fileSizeToBytes(options.maxSize) : undefined
}

/** Throws the `ensureBlob()` size error when `size` is above `options.maxSize`. */
export function ensureBlobSize(size: number, options: BlobEnsureOptions): void {
  const maxBytes = ensureMaxBytes(options)
  if (maxBytes !== undefined && size > maxBytes) {
    throw createError({
      statusCode: 400,
      message: `File size must be less than ${options.maxSize}`,
    })
  }
}

/** Throws the `ensureBlob()` type error when `type` is not in `options.types`. */
export function ensureBlobType(type: string, options: BlobEnsureOptions): void {
  requireEnsureOptions(options)
  // A broad type such as `image` or `text` does not accept a type that a browser opens as a page, such as SVG or HTML.
  // The app must list that type exactly.
  const shortType = isActiveContentType(type) ? undefined : type.split("/")[0]
  if (
    options.types?.length
    && !options.types.includes(type as BlobType)
    && !(shortType && options.types.includes(shortType as BlobType))
    && !(options.types.includes("pdf") && type === "application/pdf")
  ) {
    throw createError({
      statusCode: 400,
      message: `File type is invalid, must be: ${options.types.join(", ")}`,
    })
  }
}

export function ensureBlob(blob: Blob, options: BlobEnsureOptions = {}): void {
  ensureBlobSize(blob.size, options)
  ensureBlobType(blob.type, options)
}
