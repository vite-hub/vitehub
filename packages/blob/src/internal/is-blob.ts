export default function isBlob(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) return false
  if (typeof Blob !== "undefined" && value instanceof Blob) return true
  try {
    const tag = Object.prototype.toString.call(value)
    return tag === "[object Blob]" || tag === "[object File]"
  }
  catch {
    return false
  }
}
