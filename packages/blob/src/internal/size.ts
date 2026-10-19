const sizeUnits = ["B", "KB", "MB", "GB"] as const

/** Bytes for a `BlobSize` such as `"8MB"`, or `undefined` when the value is not a size. Units are powers of 1024. */
export function blobSizeToBytes(input: string): number | undefined {
  const match = /^(\d+)\s*(B|KB|MB|GB)$/i.exec(input)
  if (!match) return undefined
  // SAFETY: The regex matches only the listed units; indexOf runs on the uppercased unit.
  const unit = match[2]!.toUpperCase() as typeof sizeUnits[number]
  return Math.floor(Number.parseFloat(match[1]!) * 1024 ** sizeUnits.indexOf(unit))
}
