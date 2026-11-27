import type { BlobDriverByteRange } from "../types.ts"

import { byteRangeBounds } from "./byte-range.ts"

export function matchesETag(condition: string | null, etag: string | undefined): boolean {
  if (!condition) return false
  if (condition.trim() === "*") return true
  return Boolean(etag && condition.match(/(?:W\/)?"[^"]*"/g)?.some(tag => tag.replace(/^W\//, "") === etag.replace(/^W\//, "")))
}

/** Reads one `Range: bytes=` spec. Returns `undefined` for no range, several ranges, or a malformed header. */
export function parseByteRange(header: string | null): BlobDriverByteRange | undefined {
  if (!header) return
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return
  if (!match[1]) return { suffix: Number(match[2]) }
  const offset = Number(match[1])
  if (!match[2]) return { offset }
  const end = Number(match[2])
  return end < offset ? undefined : { offset, length: end - offset + 1 }
}

/**
 * Selects the bytes to send. Returns `undefined` to send the whole body: no range, several ranges, a stale `If-Range`,
 * or a malformed header. Browsers need ranges to seek media, and Safari does not play video without them.
 */
export function selectByteRange(request: Request, etag: string | undefined, size: number): { start: number, end: number } | "unsatisfiable" | undefined {
  // RFC 9110 section 14.2 requires ignoring Range on methods other than GET.
  if (request.method !== "GET") return
  const range = parseByteRange(request.headers.get("range"))
  if (!range) return
  const ifRange = request.headers.get("if-range")
  // Only a strong ETag can validate If-Range. Without a match, send the current whole body.
  if (ifRange !== null && (!etag || ifRange !== etag)) return
  return byteRangeBounds(range, size) ?? "unsatisfiable"
}

