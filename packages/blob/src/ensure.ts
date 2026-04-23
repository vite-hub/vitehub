import { createError } from "h3"

import type { BlobEnsureOptions, BlobType, SizeUnit } from "./types.ts"

const FILESIZE_UNITS = ["B", "KB", "MB", "GB"] as const

function fileSizeToBytes(input: string) {
  const regex = new RegExp(`^(\\d+)(\\.\\d+)?\\s*(${FILESIZE_UNITS.join("|")})$`, "i")
  const match = input.match(regex)
  if (!match) {
    throw createError({ statusCode: 400, message: `Invalid file size format: ${input}` })
  }

  const sizeValue = Number.parseFloat(match[1]!)
  const sizeUnit = match[3]!.toUpperCase() as SizeUnit
  if (!FILESIZE_UNITS.includes(sizeUnit)) {
    throw createError({ statusCode: 400, message: `Invalid file size unit: ${sizeUnit}` })
  }

  return Math.floor(sizeValue * Math.pow(1024, FILESIZE_UNITS.indexOf(sizeUnit)))
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
