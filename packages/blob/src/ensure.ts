import { createError } from "h3"

import { blobSizeToBytes } from "./internal/size.ts"

import type { BlobEnsureOptions, BlobType } from "./types.ts"

function fileSizeToBytes(input: string) {
  const bytes = blobSizeToBytes(input)
  if (bytes === undefined) {
    throw createError({ statusCode: 400, message: `Invalid file size format: ${input}` })
  }
  return bytes
}

export function ensureBlob(blob: Blob, options: BlobEnsureOptions = {}): void {
  if (!options.maxSize && !options.types?.length) {
    throw createError({
      statusCode: 400,
      message: "ensureBlob() requires at least one of maxSize or types to be set.",
    })
  }

  if (options.maxSize) {
    const maxFileSizeBytes = fileSizeToBytes(options.maxSize)
    if (blob.size > maxFileSizeBytes) {
      throw createError({
        statusCode: 400,
        message: `File size must be less than ${options.maxSize}`,
      })
    }
  }

  const blobShortType = blob.type.split("/")[0]
  if (
    options.types?.length
    && !options.types.includes(blob.type as BlobType)
    && !options.types.includes(blobShortType as BlobType)
    && !(options.types.includes("pdf") && blob.type === "application/pdf")
  ) {
    throw createError({
      statusCode: 400,
      message: `File type is invalid, must be: ${options.types.join(", ")}`,
    })
  }
}
