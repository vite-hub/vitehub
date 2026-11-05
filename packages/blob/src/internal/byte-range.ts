import type { BlobDriverByteRange } from "../types.ts"

/** The first and last byte of a range in an object of `size` bytes, or `undefined` when the range starts past its end. */
export function byteRangeBounds(range: BlobDriverByteRange, size: number): { start: number, end: number } | undefined {
  if ("suffix" in range) return range.suffix > 0 && size > 0 ? { start: Math.max(0, size - range.suffix), end: size - 1 } : undefined
  if (range.offset >= size) return
  return { start: range.offset, end: range.length === undefined ? size - 1 : Math.min(size, range.offset + range.length) - 1 }
}
