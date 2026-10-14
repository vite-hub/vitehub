const blobAccessors = (() => {
  const prototype = globalThis.Blob?.prototype
  return {
    type: prototype && Object.getOwnPropertyDescriptor(prototype, "type")?.get,
    size: prototype && Object.getOwnPropertyDescriptor(prototype, "size")?.get,
  }
})()

export default function isBlob(value: unknown): value is Blob {
  try {
    // Calling these accessors validates the Blob internal slots, including for
    // Blob and File instances created in another realm. Unlike toString(), the
    // accessors cannot be spoofed with Symbol.toStringTag.
    if (!blobAccessors.type || !blobAccessors.size) return false
    blobAccessors.type.call(value)
    blobAccessors.size.call(value)
    return true
  }
  catch {
    return false
  }
}
