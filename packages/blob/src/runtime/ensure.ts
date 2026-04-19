import { createError } from "h3"
import type { BlobEnsureOptions, BlobType, SizeUnit } from "./types.ts"

const FILESIZE_UNITS = ["B", "KB", "MB", "GB"] as const

export function ensureBlob(blob: Blob, options: BlobEnsureOptions = {}): void {
  if (!options.maxSize && !options.types?.length) {
    throw createError({
      message: "ensureBlob() requires at least one of maxSize or types to be set.",
      statusCode: 400,
    })
  }

  if (options.maxSize) {
    const maxFileSizeBytes = fileSizeToBytes(options.maxSize)
    if (blob.size > maxFileSizeBytes) {
      throw createError({
        message: `File size must be less than ${options.maxSize}`,
        statusCode: 400,
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
      message: `File type is invalid, must be: ${options.types.join(", ")}`,
      statusCode: 400,
    })
  }
}

function fileSizeToBytes(input: string): number {
  const regex = new RegExp(`^(\\d+)(\\.\\d+)?\\s*(${FILESIZE_UNITS.join("|")})$`, "i")
  const match = input.match(regex)

  if (!match) {
    throw createError({ message: `Invalid file size format: ${input}`, statusCode: 400 })
  }

  const sizeValue = Number.parseFloat(`${match[1]!}${match[2] ?? ""}`)
  const sizeUnit = match[3]!.toUpperCase() as SizeUnit
  return Math.floor(sizeValue * 1024 ** FILESIZE_UNITS.indexOf(sizeUnit))
}
